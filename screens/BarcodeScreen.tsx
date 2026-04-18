import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { readAsStringAsync, EncodingType } from "expo-file-system/legacy";
import { lookupBarcode, BarcodeProduct } from "../lib/barcode";
import { readBarcodeFromImage, fetchSafeAlternatives, AllergenSwap } from "../lib/apis";
import { DEFAULT_ALLERGENS } from "../lib/allergens";

const COLORS = {
  red: "#BA3801", redLight: "#D45A0A", redPale: "#FFF4E6",
  orange: "#D45A0A", white: "#ffffff", bg: "#FFFDF5",
  textDark: "#1C2B38", textMid: "#4A6983", textLight: "#8FAEC2",
  border: "#FFE0A0",
};

function riskColors(risk: string) {
  switch (risk) {
    case "High":     return { bar: "#BA3801", badge: "#FFF4E6", text: "#8A2800", border: "#F4A96A" };
    case "Likely":   return { bar: "#D45A0A", badge: "#FFF8D6", text: "#A34200", border: "#FFCF6B" };
    case "Possible": return { bar: "#B08800", badge: "#FFFBE6", text: "#7A5F00", border: "#FFEC89" };
    default:         return { bar: "#2D7D5A", badge: "#E6F5EF", text: "#1A5C3F", border: "#7BC4A0" };
  }
}

export interface BarcodeScanEntry {
  dish: string;
  imageUri: string;
  allergens: Record<string, { score: number; risk: string; reason: string[] }>;
  ingredients: string[];
}

interface Props {
  selectedAllergens: Set<string>;
  customAllergens: { name: string; keywords: string[] }[];
  onScanComplete?: (entry: BarcodeScanEntry) => void;
}

export default function BarcodeScreen({ selectedAllergens, customAllergens, onScanComplete }: Props) {
  const [loading, setLoading] = useState(false);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [product, setProduct] = useState<BarcodeProduct | null>(null);
  const [results, setResults] = useState<Record<string, { score: number; risk: string; reason: string[] }> | null>(null);
  const [swaps, setSwaps] = useState<AllergenSwap[]>([]);

  const processBarcode = async (uri: string) => {
    setLoading(true);
    setImageUri(uri);
    try {
      const base64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
      const barcodeData = await readBarcodeFromImage(base64);
      const p = await lookupBarcode(barcodeData);
      setProduct(p);

      const allergens = [
        ...DEFAULT_ALLERGENS.filter((a) => selectedAllergens.has(a.id)),
        ...customAllergens.map((ca, i) => ({ id: `custom_${i}`, name: ca.name, keywords: ca.keywords, custom: true })),
      ];

      const ingText = p.ingredientsText.toLowerCase();
      const scored: Record<string, { score: number; risk: string; reason: string[] }> = {};
      for (const allergen of allergens) {
        const inLabel = p.allergenIds.includes(allergen.id);
        const inIngredients = allergen.keywords.some((kw) =>
          ingText.includes(kw.toLowerCase())
        );

        let score: number;
        let risk: "High" | "Likely" | "Low";
        const reason: string[] = [];

        if (inLabel) {
          score = 95;
          risk = "High";
          reason.push(`${allergen.name} declared on product allergen label`);
          if (inIngredients) reason.push("Also found in ingredients list");
        } else if (inIngredients) {
          score = 78;
          risk = "Likely";
          reason.push(`${allergen.name} found in ingredients list`);
          reason.push("Not in official allergen declarations — may be trace/derivative");
        } else {
          score = 5;
          risk = "Low";
          reason.push(`No ${allergen.name} detected in ingredients or allergen label`);
        }

        scored[allergen.id] = { score, risk, reason };
      }
      setResults(scored);

      const riskyNames = allergens
        .filter((a) => scored[a.id]?.risk === "High" || scored[a.id]?.risk === "Likely")
        .map((a) => a.name);
      if (riskyNames.length > 0) {
        fetchSafeAlternatives(p.name, riskyNames, p.ingredients).then(setSwaps);
      }

      onScanComplete?.({ dish: p.name, imageUri: uri, allergens: scored, ingredients: p.ingredients });
    } catch (err) {
      Alert.alert("Lookup Failed", err instanceof Error ? err.message : "Could not find product");
      setImageUri(null);
      setSwaps([]);
    } finally {
      setLoading(false);
    }
  };

  const scanWithCamera = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") { Alert.alert("Permission needed", "Allow camera access."); return; }
    const res = await ImagePicker.launchCameraAsync({ quality: 1.0, base64: false });
    if (!res.canceled && res.assets[0]) {
      await processBarcode(res.assets[0].uri);
    }
  };

  const scanFromLibrary = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") { Alert.alert("Permission needed", "Allow photo library access."); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ quality: 1.0 });
    if (!res.canceled && res.assets[0]) {
      await processBarcode(res.assets[0].uri);
    }
  };

  const reset = () => {
    setProduct(null);
    setResults(null);
    setImageUri(null);
    setSwaps([]);
  };

  if (loading) {
    return (
      <View style={s.center}>
        <ActivityIndicator size="large" color={COLORS.red} />
        <Text style={s.loadingText}>{imageUri ? "Looking up product…" : "Processing…"}</Text>
      </View>
    );
  }

  if (product && results) {
    const allergens = [
      ...DEFAULT_ALLERGENS.filter((a) => selectedAllergens.has(a.id)),
      ...customAllergens.map((ca, i) => ({ id: `custom_${i}`, name: ca.name, keywords: ca.keywords })),
    ].sort((a, b) => {
      const order: Record<string, number> = { High: 0, Likely: 1, Possible: 2, Low: 3 };
      return (order[results[a.id]?.risk ?? "Low"] ?? 3) - (order[results[b.id]?.risk ?? "Low"] ?? 3);
    });

    return (
      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        <View style={s.productCard}>
          {product.imageUrl ? (
            <Image source={{ uri: product.imageUrl }} style={s.productImage} resizeMode="contain" />
          ) : (
            <Feather name="package" size={64} color={COLORS.textMid} style={{ marginBottom: 12 }} />
          )}
          <Text style={s.productName}>{product.name}</Text>
          {!!product.brand && <Text style={s.productBrand}>{product.brand}</Text>}
          <Text style={s.productSub}>
            {product.ingredients.length} ingredients • Verified by Open Food Facts
          </Text>
        </View>

        <Text style={s.sectionTitle}>Allergen Risk Assessment</Text>
        {allergens.map((a) => {
          const d = results[a.id];
          if (!d) return null;
          const c = riskColors(d.risk);
          return (
            <View key={a.id} style={[s.card, { borderColor: c.border }]}>
              <View style={s.cardRow}>
                <Text style={s.cardTitle}>{a.name}</Text>
                <View style={[s.badge, { backgroundColor: c.badge, borderColor: c.border }]}>
                  <Text style={[s.badgeText, { color: c.text }]}>{d.risk}</Text>
                </View>
              </View>
              <View style={s.progressBg}>
                <View style={[s.progressFill, { width: `${d.score}%`, backgroundColor: c.bar }]} />
              </View>
              <Text style={s.scoreText}>{d.score}% risk</Text>
              {d.reason.map((r, i) => (
                <Text key={i} style={s.reasonText}>• {r}</Text>
              ))}
            </View>
          );
        })}

        {swaps.length > 0 && (
          <View style={s.swapsCard}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 10 }}>
              <Feather name="refresh-cw" size={13} color="#1A5C3F" />
              <Text style={s.swapsTitle}>Safe Swap Suggestions</Text>
            </View>
            {swaps.map((sw, i) => (
              <View key={i} style={s.swapRow}>
                <Text style={s.swapAllergen}>{sw.allergen}</Text>
                <Feather name="arrow-right" size={12} color="#4A6983" style={{ marginHorizontal: 6 }} />
                <Text style={s.swapAlts}>{sw.alternatives.join(" • ")}</Text>
              </View>
            ))}
          </View>
        )}

        <TouchableOpacity style={s.scanAgainBtn} onPress={reset}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Feather name="package" size={16} color={COLORS.red} />
            <Text style={s.scanAgainText}>Scan Another Product</Text>
          </View>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <View style={s.center}>
      <Feather name="package" size={64} color={COLORS.red} style={{ marginBottom: 16 }} />
      <Text style={s.scanTitle}>Barcode Scanner</Text>
      <Text style={s.scanSubtitle}>
        Point your camera at any packaged food barcode for instant allergen analysis using Open Food Facts (3M+ products)
      </Text>
      <TouchableOpacity style={s.startBtn} onPress={scanWithCamera}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Feather name="camera" size={16} color="#fff" />
          <Text style={s.startBtnText}>Scan with Camera</Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity style={[s.startBtn, s.libraryBtn]} onPress={scanFromLibrary}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Feather name="image" size={16} color={COLORS.red} />
          <Text style={[s.startBtnText, { color: COLORS.red }]}>Choose from Library</Text>
        </View>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, backgroundColor: COLORS.bg },
  scroll: { flex: 1, backgroundColor: COLORS.bg },
  scrollContent: { padding: 20, paddingTop: 16, paddingBottom: 48 },

  scanIcon: { fontSize: 64, marginBottom: 16 },
  scanTitle: { fontSize: 24, fontWeight: "800", color: COLORS.red, marginBottom: 10 },
  scanSubtitle: { fontSize: 14, color: COLORS.textMid, textAlign: "center", lineHeight: 20, marginBottom: 32 },
  startBtn: {
    backgroundColor: COLORS.red, borderRadius: 18, paddingVertical: 16, paddingHorizontal: 40,
    shadowColor: COLORS.red, shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 5 },
    marginBottom: 12, width: "100%", alignItems: "center",
  },
  libraryBtn: { backgroundColor: COLORS.white, borderWidth: 2, borderColor: COLORS.red, shadowOpacity: 0 },
  startBtnText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  loadingText: { marginTop: 16, fontSize: 15, color: COLORS.textMid, fontWeight: "600" },

  productCard: {
    backgroundColor: COLORS.white, borderRadius: 20, padding: 20, marginBottom: 16,
    alignItems: "center", borderWidth: 1, borderColor: COLORS.border,
    shadowColor: COLORS.red, shadowOpacity: 0.07, shadowRadius: 12, shadowOffset: { width: 0, height: 3 },
  },
  productImage: { width: 120, height: 120, borderRadius: 12, marginBottom: 12 },
  productEmoji: { fontSize: 64, marginBottom: 12 },
  productName: { fontSize: 20, fontWeight: "800", color: COLORS.textDark, textAlign: "center" },
  productBrand: { fontSize: 14, color: COLORS.textMid, marginTop: 4 },
  productSub: { fontSize: 12, color: COLORS.textLight, marginTop: 6, textAlign: "center" },

  sectionTitle: { fontSize: 15, fontWeight: "700", color: COLORS.textDark, marginBottom: 12 },
  card: {
    backgroundColor: COLORS.white, borderRadius: 18, padding: 14, borderWidth: 1.5, marginBottom: 12,
    shadowColor: COLORS.red, shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
  },
  cardRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  cardTitle: { fontSize: 15, fontWeight: "700", color: COLORS.textDark },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderWidth: 1.5 },
  badgeText: { fontSize: 11, fontWeight: "700" },
  progressBg: { height: 8, backgroundColor: COLORS.redPale, borderRadius: 4, marginBottom: 6, overflow: "hidden" },
  progressFill: { height: 8, borderRadius: 4 },
  scoreText: { fontSize: 12, color: COLORS.textMid, marginBottom: 6, fontWeight: "500" },
  reasonText: { fontSize: 12, color: COLORS.textMid, lineHeight: 17 },

  swapsCard: {
    backgroundColor: "#E6F5EF", borderRadius: 18, padding: 14, borderWidth: 1.5,
    borderColor: "#7BC4A0", marginBottom: 12,
  },
  swapsTitle: { fontSize: 14, fontWeight: "700", color: "#1A5C3F" },
  swapRow: { flexDirection: "row", alignItems: "flex-start", marginBottom: 6 },
  swapAllergen: { fontSize: 12, fontWeight: "700", color: "#1A5C3F", minWidth: 65 },
  swapAlts: { fontSize: 12, color: "#2D5A40", flex: 1, lineHeight: 17 },

  scanAgainBtn: {
    borderWidth: 2, borderColor: COLORS.red, borderRadius: 18, paddingVertical: 15, alignItems: "center",
    marginTop: 8, backgroundColor: COLORS.white,
  },
  scanAgainText: { color: COLORS.red, fontSize: 15, fontWeight: "700" },
});
