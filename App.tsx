import React, { useState, useEffect, useCallback, useRef } from "react";
import { LogBox } from "react-native";
LogBox.ignoreAllLogs();
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Feather, FontAwesome5, MaterialCommunityIcons } from "@expo/vector-icons";
import { useFonts, Nunito_400Regular, Nunito_600SemiBold, Nunito_700Bold, Nunito_800ExtraBold } from "@expo-google-fonts/nunito";
import { StatusBar } from "expo-status-bar";
import * as ImagePicker from "expo-image-picker";
import { readAsStringAsync, EncodingType } from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_ALLERGENS, Allergen } from "./lib/allergens";
import { scoreAllergen } from "./lib/scoring";
import {
  identifyDishFromImage,
  fetchAllIngredients,
  analyzeDishFromName,
  fetchSafeAlternatives,
  AllergenSwap,
  GROQ_API_KEY,
} from "./lib/apis";
import { initHealth, logAllergenExposure, isHealthAvailable } from "./lib/health";
import { startLocationMonitoring, stopLocationMonitoring, isMonitoring, requestNotificationPermission } from "./lib/locationMonitor";
import * as Notifications from "expo-notifications";
import BarcodeScreen from "./screens/BarcodeScreen";
import type { BarcodeScanEntry } from "./screens/BarcodeScreen";
import AnalyticsScreen from "./screens/AnalyticsScreen";
import SafetyMapScreen from "./screens/SafetyMapScreen";
import type { SavedRestaurant, MapAnalysisEntry } from "./screens/SafetyMapScreen";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AllergenResult {
  score: number;
  risk: "Low" | "Possible" | "Likely" | "High";
  reason: string[];
}

interface AnalysisResult {
  dish: string;
  visionConfidence: number;
  visibleIngredients: string[];
  hiddenIngredients: string[];
  uncertaintyNotes: string[];
  ingredients: string[];
  allergens: Record<string, AllergenResult>;
}

interface HistoryEntry {
  id: string;
  timestamp: number;
  imageUri: string;
  result: AnalysisResult;
}

type Tab = "scan" | "barcode" | "analytics" | "map";

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEYS = {
  ALLERGEN_SELECTIONS: "allergen_selections_v1",
  CUSTOM_ALLERGENS: "custom_allergens_v1",
  SCAN_HISTORY: "scan_history_v2",
};
const MAX_HISTORY = 50;
const RISK_ORDER: Record<string, number> = { High: 0, Likely: 1, Possible: 2, Low: 3 };

// ─── Theme ────────────────────────────────────────────────────────────────────

const COLORS = {
  red:        "#BA3801",
  redPale:    "#FFF4E6",
  orange:     "#D45A0A",
  orangePale: "#FFF8D6",
  white:      "#ffffff",
  bg:         "#FFFDF5",
  textDark:   "#1C2B38",
  textMid:    "#4A6983",
  textLight:  "#8FAEC2",
  border:     "#FFE0A0",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function riskColors(risk: string) {
  switch (risk) {
    case "High":     return { bar: "#BA3801", badge: "#FFF4E6", text: "#8A2800", border: "#F4A96A" };
    case "Likely":   return { bar: "#D45A0A", badge: "#FFF8D6", text: "#A34200", border: "#FFCF6B" };
    case "Possible": return { bar: "#B08800", badge: "#FFFBE6", text: "#7A5F00", border: "#FFEC89" };
    default:         return { bar: "#2D7D5A", badge: "#E6F5EF", text: "#1A5C3F", border: "#7BC4A0" };
  }
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function topRisk(allergens: Record<string, AllergenResult>): string {
  let best = "Low";
  for (const v of Object.values(allergens)) {
    if (RISK_ORDER[v.risk] < RISK_ORDER[best]) best = v.risk;
  }
  return best;
}

const SCREEN_W = Dimensions.get("window").width;

// ─── Allergen Card ────────────────────────────────────────────────────────────

function AllergenCard({ name, score, risk, reason }: { name: string; score: number; risk: string; reason: string[] }) {
  const c = riskColors(risk);
  return (
    <View style={[styles.card, { borderColor: c.border }]}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{name}</Text>
        <View style={[styles.badge, { backgroundColor: c.badge, borderColor: c.border }]}>
          <Text style={[styles.badgeText, { color: c.text }]}>{risk}</Text>
        </View>
      </View>
      <View style={styles.progressBg}>
        <View style={[styles.progressFill, { width: `${score}%`, backgroundColor: c.bar }]} />
      </View>
      <Text style={styles.scoreText}>{score}% risk</Text>
      {reason.map((r, i) => (
        <View key={i} style={styles.reasonRow}>
          <Text style={styles.bullet}>•</Text>
          <Text style={styles.reasonText}>{r}</Text>
        </View>
      ))}
    </View>
  );
}

// ─── History Item / Modal ─────────────────────────────────────────────────────

function HistoryItem({ entry, onPress }: { entry: HistoryEntry; onPress: () => void }) {
  const risk = topRisk(entry.result.allergens);
  const c = riskColors(risk);
  return (
    <TouchableOpacity style={styles.historyItem} onPress={onPress} activeOpacity={0.7}>
      {entry.imageUri ? (
        <Image source={{ uri: entry.imageUri }} style={styles.historyThumb} />
      ) : (
        <View style={[styles.historyThumb, { backgroundColor: COLORS.redPale, alignItems: "center", justifyContent: "center" }]}>
          <Feather name="map-pin" size={22} color={COLORS.textMid} />
        </View>
      )}
      <View style={styles.historyInfo}>
        <Text style={styles.historyDish} numberOfLines={1}>{entry.result.dish}</Text>
        <Text style={styles.historyTime}>{formatDate(entry.timestamp)}</Text>
      </View>
      <View style={[styles.badge, { backgroundColor: c.badge, borderColor: c.border, alignSelf: "center" }]}>
        <Text style={[styles.badgeText, { color: c.text }]}>{risk}</Text>
      </View>
    </TouchableOpacity>
  );
}

function HistoryModal({ visible, history, onClose, onSelect, onClear }: {
  visible: boolean; history: HistoryEntry[]; onClose: () => void;
  onSelect: (e: HistoryEntry) => void; onClear: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.modalContainer}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Scan History</Text>
          <View style={{ flexDirection: "row", gap: 12 }}>
            {history.length > 0 && <TouchableOpacity onPress={onClear}><Text style={styles.clearBtn}>Clear</Text></TouchableOpacity>}
            <TouchableOpacity onPress={onClose}><Text style={styles.doneBtn}>Done</Text></TouchableOpacity>
          </View>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          {history.length === 0 ? (
            <Text style={styles.emptyHistory}>No scans yet. Analyze a food photo to get started.</Text>
          ) : (
            history.map((entry) => (
              <HistoryItem key={entry.id} entry={entry} onPress={() => { onSelect(entry); onClose(); }} />
            ))
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ─── Tab Bar ─────────────────────────────────────────────────────────────────

function TabBar({ activeTab, onSelect }: { activeTab: Tab; onSelect: (t: Tab) => void }) {
  const tabs: { id: Tab; icon: string; label: string }[] = [
    { id: "scan",      icon: "camera",     label: "Scan"      },
    { id: "barcode",   icon: "maximize",   label: "Barcode"   },
    { id: "analytics", icon: "bar-chart-2",label: "Analytics" },
    { id: "map",       icon: "map-pin",    label: "Map"       },
  ];
  return (
    <View style={tabStyles.bar}>
      {tabs.map((t) => {
        const active = activeTab === t.id;
        return (
          <TouchableOpacity key={t.id} style={tabStyles.tab} onPress={() => onSelect(t.id)} activeOpacity={0.7}>
            <Feather name={t.icon as any} size={22} color={active ? COLORS.red : "#c4887f"} />
            <Text style={[tabStyles.label, active && tabStyles.labelActive]}>{t.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const tabStyles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    backgroundColor: COLORS.white,
    borderTopWidth: 1.5,
    borderTopColor: COLORS.border,
    paddingBottom: Platform.OS === "ios" ? 24 : 8,
    paddingTop: 8,
    shadowColor: COLORS.red,
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  tab: { flex: 1, alignItems: "center" },
  emoji: { fontSize: 22, opacity: 0.45 },
  emojiActive: { opacity: 1 },
  label: { fontSize: 10, fontFamily: "Nunito_600SemiBold", color: COLORS.textLight, marginTop: 3, letterSpacing: 0.3 },
  labelActive: { color: COLORS.red, fontFamily: "Nunito_800ExtraBold" },
});

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [fontsLoaded] = useFonts({ Nunito_400Regular, Nunito_600SemiBold, Nunito_700Bold, Nunito_800ExtraBold });
  const [activeTab, setActiveTab] = useState<Tab>("scan");

  // Scan state
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageMime, setImageMime] = useState("image/jpeg");

  const [dishName, setDishName] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [cuisineType, setCuisineType] = useState("");

  const [selectedAllergens, setSelectedAllergens] = useState<Set<string>>(
    new Set(DEFAULT_ALLERGENS.map((a) => a.id))
  );
  const [customAllergens, setCustomAllergens] = useState<{ name: string; keywords: string[] }[]>([]);
  const [newName, setNewName] = useState("");
  const [newKeywords, setNewKeywords] = useState("");

  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [swaps, setSwaps] = useState<AllergenSwap[]>([]);

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // Location monitoring
  const [monitoringActive, setMonitoringActive] = useState(false);
  const [pendingNotificationPlace, setPendingNotificationPlace] = useState<string | null>(null);

  // Apple Health
  const [healthReady, setHealthReady] = useState(false);
  const [healthLogged, setHealthLogged] = useState(false);
  const [healthLogging, setHealthLogging] = useState(false);

  // Safety map
  const [pendingMapRestaurant, setPendingMapRestaurant] = useState<{
    name: string; riskyAllergens: string[]; safeAllergens: string[]; riskLevel: "Safe" | "Caution" | "Avoid";
  } | null>(null);

  // ── Init ──
  useEffect(() => {
    (async () => {
      try {
        const [savedSelections, savedCustom, savedHistory] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.ALLERGEN_SELECTIONS),
          AsyncStorage.getItem(STORAGE_KEYS.CUSTOM_ALLERGENS),
          AsyncStorage.getItem(STORAGE_KEYS.SCAN_HISTORY),
        ]);
        if (savedSelections) setSelectedAllergens(new Set(JSON.parse(savedSelections)));
        if (savedCustom) setCustomAllergens(JSON.parse(savedCustom));
        if (savedHistory) setHistory(JSON.parse(savedHistory));
      } catch {}
      if (isHealthAvailable) {
        const ok = await initHealth();
        setHealthReady(ok);
      }
      await requestNotificationPermission();
      const active = await isMonitoring();
      setMonitoringActive(active);

      // Handle tapping a food-place notification
      const sub = Notifications.addNotificationResponseReceivedListener((response) => {
        const placeName = response.notification.request.content.data?.placeName as string | undefined;
        if (placeName) {
          setActiveTab("map");
          setPendingNotificationPlace(placeName);
        }
      });
      return () => sub.remove();
    })();
  }, []);

  const saveAllergenSelections = useCallback(async (s: Set<string>) => {
    try { await AsyncStorage.setItem(STORAGE_KEYS.ALLERGEN_SELECTIONS, JSON.stringify([...s])); } catch {}
  }, []);
  const saveCustomAllergens = useCallback(async (c: { name: string; keywords: string[] }[]) => {
    try { await AsyncStorage.setItem(STORAGE_KEYS.CUSTOM_ALLERGENS, JSON.stringify(c)); } catch {}
  }, []);
  const saveHistory = useCallback(async (e: HistoryEntry[]) => {
    try { await AsyncStorage.setItem(STORAGE_KEYS.SCAN_HISTORY, JSON.stringify(e)); } catch {}
  }, []);

  const addToHistory = useCallback((entry: HistoryEntry) => {
    setHistory((prev) => {
      const next = [entry, ...prev].slice(0, MAX_HISTORY);
      saveHistory(next);
      return next;
    });
  }, [saveHistory]);

  // ── Image picker ──
  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") { Alert.alert("Permission needed", "Allow photo access."); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
    if (!res.canceled && res.assets[0]) {
      setImageUri(res.assets[0].uri);
      setImageMime(res.assets[0].mimeType || "image/jpeg");
      setResult(null);
    }
  };

  const takePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") { Alert.alert("Permission needed", "Allow camera access."); return; }
    const res = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (!res.canceled && res.assets[0]) {
      setImageUri(res.assets[0].uri);
      setImageMime(res.assets[0].mimeType || "image/jpeg");
      setResult(null);
    }
  };

  // ── Allergen toggles ──
  const toggleAllergen = (id: string) => {
    setSelectedAllergens((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      saveAllergenSelections(next);
      return next;
    });
  };
  const addCustomAllergen = () => {
    const name = newName.trim();
    if (!name) return;
    const keywords = newKeywords.split(",").map((k) => k.trim()).filter(Boolean);
    setCustomAllergens((prev) => {
      const next = [...prev, { name, keywords: keywords.length ? keywords : [name.toLowerCase()] }];
      saveCustomAllergens(next);
      return next;
    });
    setNewName(""); setNewKeywords("");
  };
  const removeCustomAllergen = (index: number) => {
    setCustomAllergens((prev) => { const next = prev.filter((_, j) => j !== index); saveCustomAllergens(next); return next; });
  };

  // ── Core analyze logic ──
  const runAnalysis = async (visionResult: Awaited<ReturnType<typeof identifyDishFromImage>>, resolvedDish: string) => {
    const allVisionIngredients = [...visionResult.visibleIngredients, ...visionResult.hiddenIngredients];
    const recipeData = await fetchAllIngredients(resolvedDish, allVisionIngredients);
    const allIngredients = [...new Set([...allVisionIngredients, ...recipeData.ingredients])];

    const allergensToScore: Allergen[] = [
      ...DEFAULT_ALLERGENS.filter((a) => selectedAllergens.has(a.id)),
      ...customAllergens.map((ca, i) => ({ id: `custom_${i}`, name: ca.name, keywords: ca.keywords, custom: true })),
    ];

    const allergenResults: Record<string, AllergenResult> = {};
    for (const allergen of allergensToScore) {
      let maxFreq = 0;
      for (const kw of allergen.keywords) {
        const kwNorm = kw.toLowerCase();
        for (const [ing, freq] of Object.entries(recipeData.ingredientFrequencies)) {
          if (ing.includes(kwNorm) || kwNorm.includes(ing)) maxFreq = Math.max(maxFreq, freq);
        }
      }
      allergenResults[allergen.id] = scoreAllergen({
        allergen,
        visionConfidence: visionResult.visionConfidence,
        visibleIngredients: visionResult.visibleIngredients,
        hiddenIngredients: visionResult.hiddenIngredients,
        recipeIngredients: recipeData.ingredients,
        ingredientFrequency: maxFreq,
        dishName: resolvedDish,
        allergenFlag: visionResult.allergenFlags[allergen.id],
      });
    }
    return { allergenResults, allIngredients, visionResult };
  };

  // ── Food photo analyze ──
  const handleAnalyze = async () => {
    if (!dishName.trim()) return;
    if (!GROQ_API_KEY) { Alert.alert("API Key Missing", "Add your Groq API key in lib/apis.ts"); return; }
    setLoading(true);
    setHealthLogged(false);
    try {
      let visionResult: Awaited<ReturnType<typeof identifyDishFromImage>>;

      if (!imageUri) {
        visionResult = await analyzeDishFromName(dishName.trim(), restaurantName.trim() || undefined);
      } else {
        const base64 = await readAsStringAsync(imageUri!, { encoding: EncodingType.Base64 });
        visionResult = await identifyDishFromImage(
          base64, imageMime,
          dishName.trim(),
          restaurantName.trim() || undefined,
          cuisineType.trim() || undefined
        );
      }

      const resolvedDish = dishName.trim();
      const { allergenResults, allIngredients } = await runAnalysis(visionResult, resolvedDish);

      const newResult: AnalysisResult = {
        dish: resolvedDish,
        visionConfidence: visionResult.visionConfidence,
        visibleIngredients: visionResult.visibleIngredients,
        hiddenIngredients: visionResult.hiddenIngredients,
        uncertaintyNotes: visionResult.uncertaintyNotes,
        ingredients: allIngredients,
        allergens: allergenResults,
      };
      setResult(newResult);
      setSwaps([]);
      const riskyNames = Object.entries(allergenResults)
        .filter(([, v]) => v.risk === "High" || v.risk === "Likely")
        .map(([id]) => DEFAULT_ALLERGENS.find((a) => a.id === id)?.name ?? id);
      if (riskyNames.length > 0) {
        fetchSafeAlternatives(resolvedDish, riskyNames, allIngredients).then(setSwaps);
      }

      // Save to history
      const entry: HistoryEntry = {
        id: Date.now().toString(),
        timestamp: Date.now(),
        imageUri: imageUri ?? "",
        result: newResult,
      };
      setHistory((prev) => {
        const next = [entry, ...prev].slice(0, MAX_HISTORY);
        saveHistory(next);
        return next;
      });
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  // ── Apple Health logging ──
  const handleLogHealth = async () => {
    if (!result) return;
    setHealthLogging(true);
    const highRisk = Object.entries(result.allergens)
      .filter(([, v]) => v.risk === "High" || v.risk === "Likely")
      .map(([id]) => DEFAULT_ALLERGENS.find((a) => a.id === id)?.name ?? id);

    const { success, message } = await logAllergenExposure(result.dish, highRisk);
    setHealthLogging(false);
    if (success) {
      setHealthLogged(true);
      Alert.alert("Logged to Apple Health", message);
    } else {
      Alert.alert("Health Log", message);
    }
  };

  // ── Save to safety map ──
  const handleSaveToMap = () => {
    if (!result || !restaurantName.trim()) return;
    const riskyAllergens = Object.entries(result.allergens)
      .filter(([, v]) => v.risk === "High" || v.risk === "Likely")
      .map(([id]) => DEFAULT_ALLERGENS.find((a) => a.id === id)?.name ?? id);
    const safeAllergens = Object.entries(result.allergens)
      .filter(([, v]) => v.risk === "Low")
      .map(([id]) => DEFAULT_ALLERGENS.find((a) => a.id === id)?.name ?? id);
    const worst = topRisk(result.allergens);
    const riskLevel = worst === "High" || worst === "Likely" ? "Avoid"
      : worst === "Possible" ? "Caution" : "Safe";
    setPendingMapRestaurant({ name: restaurantName.trim(), riskyAllergens, safeAllergens, riskLevel });
    setActiveTab("map");
  };

  const loadHistoryEntry = (entry: HistoryEntry) => {
    setImageUri(entry.imageUri);
    setResult(entry.result);
    setDishName(entry.result.dish);
  };
  const clearHistory = () => {
    Alert.alert("Clear History", "Remove all saved scans?", [
      { text: "Cancel", style: "cancel" },
      { text: "Clear", style: "destructive", onPress: () => { setHistory([]); saveHistory([]); } },
    ]);
  };

  const displayAllergens: Allergen[] = [
    ...DEFAULT_ALLERGENS.filter((a) => selectedAllergens.has(a.id)),
    ...customAllergens.map((ca, i) => ({ id: `custom_${i}`, name: ca.name, keywords: ca.keywords, custom: true })),
  ];
  const sortedDisplayAllergens = result
    ? [...displayAllergens].sort((a, b) => {
        const ra = result.allergens[a.id]?.risk ?? "Low";
        const rb = result.allergens[b.id]?.risk ?? "Low";
        return (RISK_ORDER[ra] ?? 3) - (RISK_ORDER[rb] ?? 3);
      })
    : displayAllergens;

  const resetScan = () => {
    setImageUri(null); setResult(null); setDishName(""); setRestaurantName(""); setCuisineType(""); setHealthLogged(false); setSwaps([]);
  };

  // ── Scan screen content ──
  const ScanScreen = (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: COLORS.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Image source={require("./assets/icon.png")} style={styles.logoMark} resizeMode="cover" />
              <View>
                <Text style={styles.title}>SafeEats</Text>
                <Text style={styles.subtitle}>snap a photo, eat with confidence</Text>
              </View>
            </View>
            <TouchableOpacity style={styles.historyBtn} onPress={() => setShowHistory(true)}>
              <Feather name="clock" size={20} color={COLORS.textMid} />
              {history.length > 0 && (
                <View style={styles.historyBadge}>
                  <Text style={styles.historyBadgeText}>{history.length}</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {/* Image upload */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Food Photo (optional)</Text>
          {imageUri ? (
            <>
              <Image source={{ uri: imageUri }} style={styles.imagePreview} resizeMode="cover" />
              <Pressable style={styles.changeBtn} onPress={pickImage}>
                <Text style={styles.changeBtnText}>Change Photo</Text>
              </Pressable>
            </>
          ) : (
            <View style={styles.uploadRow}>
              <TouchableOpacity style={styles.uploadBtn} onPress={pickImage}>
                <Feather name="image" size={28} color={COLORS.red} style={{ marginBottom: 6 }} />
                <Text style={styles.uploadBtnText}>Photo Library</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.uploadBtn, { marginLeft: 12 }]} onPress={takePhoto}>
                <Feather name="camera" size={28} color={COLORS.red} style={{ marginBottom: 6 }} />
                <Text style={styles.uploadBtnText}>Camera</Text>
              </TouchableOpacity>
            </View>
          )}

          <View style={{ marginTop: 12 }}>
            <View style={{ marginBottom: 10 }}>
              <Text style={styles.inputLabel}>Dish name <Text style={{ color: COLORS.red }}>*</Text></Text>
              <TextInput
                style={[styles.input, !dishName.trim() && styles.inputRequired]}
                value={dishName} onChangeText={setDishName}
                placeholder="e.g. Pad Thai" placeholderTextColor={COLORS.textLight}
              />
            </View>
            <View style={{ marginBottom: 10 }}>
              <Text style={styles.inputLabel}>Restaurant (optional)</Text>
              <TextInput style={styles.input} value={restaurantName} onChangeText={setRestaurantName}
                placeholder="e.g. Thai Garden" placeholderTextColor={COLORS.textLight} />
            </View>
            <View style={{ marginBottom: 10 }}>
              <Text style={styles.inputLabel}>Cuisine type (optional)</Text>
              <TextInput style={styles.input} value={cuisineType} onChangeText={setCuisineType}
                placeholder="e.g. Thai" placeholderTextColor={COLORS.textLight} />
            </View>
          </View>
        </View>

        {/* Allergen selection */}
        <View style={styles.section}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12 }}>
            <Feather name="alert-triangle" size={14} color={COLORS.textDark} />
            <Text style={[styles.sectionTitle, { marginBottom: 0 }]}>Allergens to Check</Text>
          </View>
          <View style={styles.pillRow}>
            {DEFAULT_ALLERGENS.map((a) => (
              <TouchableOpacity
                key={a.id}
                style={[styles.pill, selectedAllergens.has(a.id) && styles.pillActive]}
                onPress={() => toggleAllergen(a.id)}
              >
                <Text style={[styles.pillText, selectedAllergens.has(a.id) && styles.pillTextActive]}>{a.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.divider} />
          <Text style={styles.customLabel}>Custom Allergens</Text>
          <TextInput style={styles.input} value={newName} onChangeText={setNewName} placeholder="Allergen name (e.g. Mustard)" placeholderTextColor="#9ca3af" />
          <TextInput style={[styles.input, { marginTop: 8 }]} value={newKeywords} onChangeText={setNewKeywords} placeholder="Keywords, comma-separated (optional)" placeholderTextColor="#9ca3af" />
          <TouchableOpacity style={[styles.addBtn, !newName.trim() && styles.addBtnDisabled]} onPress={addCustomAllergen} disabled={!newName.trim()}>
            <Text style={styles.addBtnText}>+ Add Allergen</Text>
          </TouchableOpacity>
          {customAllergens.length > 0 && (
            <View style={[styles.pillRow, { marginTop: 10 }]}>
              {customAllergens.map((ca, i) => (
                <View key={i} style={styles.customPill}>
                  <Text style={styles.customPillText}>{ca.name}</Text>
                  <Pressable onPress={() => removeCustomAllergen(i)}>
                    <Text style={styles.removePill}>  ×</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Analyze button */}
        <TouchableOpacity
            style={[styles.analyzeBtn, (!dishName.trim() || loading) && styles.analyzeBtnDisabled]}
            onPress={handleAnalyze}
            disabled={!dishName.trim() || loading}
          >
            {loading ? <ActivityIndicator color="#fff" /> : (
              <Text style={styles.analyzeBtnText}>Analyze for Allergens</Text>
            )}
          </TouchableOpacity>

        {/* Results */}
        {result && (
          <View>
            <View style={styles.section}>
              <Text style={styles.dishName}>{result.dish}</Text>
              <Text style={styles.confidence}>Vision confidence: {Math.round(result.visionConfidence * 100)}%</Text>
              {result.uncertaintyNotes?.length > 0 && (
                <View style={styles.warningBox}>
                  <Text style={styles.warningTitle}>Uncertainty Notes</Text>
                  {result.uncertaintyNotes.map((n, i) => <Text key={i} style={styles.warningText}>• {n}</Text>)}
                </View>
              )}
              {result.hiddenIngredients?.length > 0 && (
                <View style={[styles.warningBox, { marginTop: 12 }]}>
                  <Text style={styles.warningTitle}>Likely Hidden Ingredients</Text>
                  <Text style={styles.warningText}>{result.hiddenIngredients.join(", ")}</Text>
                </View>
              )}
              {result.ingredients?.length > 0 && (
                <View style={{ marginTop: 12 }}>
                  <Text style={styles.customLabel}>All Detected / Inferred Ingredients</Text>
                  <View style={styles.pillRow}>
                    {result.ingredients.slice(0, 25).map((ing) => (
                      <View key={ing} style={styles.ingPill}>
                        <Text style={styles.ingPillText}>{ing}</Text>
                      </View>
                    ))}
                    {result.ingredients.length > 25 && <Text style={styles.moreText}>+{result.ingredients.length - 25} more</Text>}
                  </View>
                </View>
              )}

              {/* Action buttons row */}
              <View style={styles.actionRow}>
                {/* Apple Health */}
                {(
                  <TouchableOpacity
                    style={[styles.actionBtn, styles.healthBtn, healthLogged && styles.healthBtnLogged]}
                    onPress={handleLogHealth}
                    disabled={healthLogging || healthLogged}
                  >
                    {healthLogging ? <ActivityIndicator color="#fff" size="small" /> : (
                      <Text style={styles.actionBtnText}>{healthLogged ? "Logged to Health" : "Log to Health"}</Text>
                    )}
                  </TouchableOpacity>
                )}
                {/* Save to Safety Map */}
                {restaurantName.trim() !== "" && (
                  <TouchableOpacity style={[styles.actionBtn, styles.mapBtn]} onPress={handleSaveToMap}>
                    <Text style={styles.actionBtnText}>Save to Map</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>

            <Text style={[styles.sectionTitle, { marginBottom: 8 }]}>Allergen Risk Assessment</Text>
            {sortedDisplayAllergens.map((a) => {
              const data = result.allergens[a.id];
              if (!data) return null;
              return <AllergenCard key={a.id} name={a.name} score={data.score} risk={data.risk} reason={data.reason} />;
            })}

            {swaps.length > 0 && (
              <View style={styles.swapsCard}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12 }}>
                  <Feather name="refresh-cw" size={14} color="#1A5C3F" />
                  <Text style={styles.swapsTitle}>Safe Swap Suggestions</Text>
                </View>
                {swaps.map((s, i) => (
                  <View key={i} style={styles.swapRow}>
                    <Text style={styles.swapAllergen}>{s.allergen}</Text>
                    <Feather name="arrow-right" size={13} color="#4A6983" style={{ marginHorizontal: 6 }} />
                    <Text style={styles.swapAlts}>{s.alternatives.join(" • ")}</Text>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.disclaimer}>
              <Text style={styles.disclaimerText}>
                Estimates only. Not guaranteed for medical safety. Always consult ingredient labels and restaurant staff if you have severe allergies.
              </Text>
            </View>

            <TouchableOpacity style={styles.scanAgainBtn} onPress={resetScan}>
              <Text style={styles.scanAgainText}>Scan Another Food</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      <HistoryModal visible={showHistory} history={history} onClose={() => setShowHistory(false)} onSelect={loadHistoryEntry} onClear={clearHistory} />
    </KeyboardAvoidingView>
  );

  return (
    <View style={{ flex: 1 }}>
      <StatusBar style="dark" />

      {/* Screen content */}
      <View style={{ flex: 1 }}>
        {activeTab === "scan"      && ScanScreen}
        {activeTab === "barcode"   && (
          <View style={{ flex: 1, paddingTop: 56 }}>
            <Text style={styles.screenHeading}>Barcode Scanner</Text>
            <BarcodeScreen
              selectedAllergens={selectedAllergens}
              customAllergens={customAllergens}
              onScanComplete={(e: BarcodeScanEntry) => addToHistory({
                id: Date.now().toString(),
                timestamp: Date.now(),
                imageUri: e.imageUri,
                result: {
                  dish: e.dish,
                  visionConfidence: 1.0,
                  visibleIngredients: e.ingredients,
                  hiddenIngredients: [],
                  uncertaintyNotes: [],
                  ingredients: e.ingredients,
                  allergens: e.allergens as Record<string, AllergenResult>,
                },
              })}
            />
          </View>
        )}
        {activeTab === "analytics" && (
          <View style={{ flex: 1, paddingTop: 56 }}>
            <Text style={styles.screenHeading}>Analytics</Text>
            <AnalyticsScreen history={history} />
          </View>
        )}
        {activeTab === "map" && (
          <View style={{ flex: 1, paddingTop: 56 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: COLORS.border, backgroundColor: COLORS.bg }}>
              <Text style={[styles.screenHeading, { paddingHorizontal: 0, paddingBottom: 0, borderBottomWidth: 0 }]}>Restaurant Safety Map</Text>
              <TouchableOpacity
                style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1.5, borderColor: monitoringActive ? COLORS.red : COLORS.border, backgroundColor: monitoringActive ? COLORS.redPale : COLORS.white }}
                onPress={async () => {
                  if (monitoringActive) {
                    await stopLocationMonitoring();
                    setMonitoringActive(false);
                  } else {
                    const ok = await startLocationMonitoring();
                    setMonitoringActive(ok);
                    if (!ok) Alert.alert("Permission needed", "Enable background location in Settings to get food place alerts.");
                  }
                }}
              >
                <Feather name="bell" size={13} color={monitoringActive ? COLORS.red : COLORS.textMid} />
                <Text style={{ fontSize: 12, fontWeight: "700", color: monitoringActive ? COLORS.red : COLORS.textMid }}>
                  {monitoringActive ? "Alerts On" : "Alerts Off"}
                </Text>
              </TouchableOpacity>
            </View>
            <SafetyMapScreen
              selectedAllergens={selectedAllergens}
              customAllergens={customAllergens}
              pendingRestaurant={pendingMapRestaurant}
              onPendingConsumed={() => setPendingMapRestaurant(null)}
              pendingSearch={pendingNotificationPlace}
              onPendingSearchConsumed={() => setPendingNotificationPlace(null)}
              onAnalysisComplete={(e: MapAnalysisEntry) => addToHistory({
                id: Date.now().toString(),
                timestamp: Date.now(),
                imageUri: "",
                result: {
                  dish: `${e.dish} @ ${e.restaurant}`,
                  visionConfidence: 1.0,
                  visibleIngredients: [],
                  hiddenIngredients: [],
                  uncertaintyNotes: [],
                  ingredients: [],
                  allergens: e.allergens as Record<string, AllergenResult>,
                },
              })}
            />
          </View>
        )}
      </View>

      <TabBar activeTab={activeTab} onSelect={setActiveTab} />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "transparent" },
  content: { padding: 20, paddingTop: 64, paddingBottom: 48 },

  screenHeading: {
    fontSize: 18, fontFamily: "Nunito_800ExtraBold", color: COLORS.textDark,
    paddingHorizontal: 20, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
    backgroundColor: COLORS.bg,
  },
  logoMark: {
    width: 46, height: 46, borderRadius: 14, backgroundColor: COLORS.red,
    alignItems: "center", justifyContent: "center",
    shadowColor: COLORS.red, shadowOpacity: 0.5, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
    borderWidth: 1.5, borderColor: "#c94b10",
  },

  actionRow: { flexDirection: "row", gap: 8, marginTop: 16, flexWrap: "wrap" },
  actionBtn: {
    flex: 1, minWidth: 130, paddingVertical: 12, paddingHorizontal: 14,
    borderRadius: 14, alignItems: "center", justifyContent: "center",
    shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
  },
  healthBtn: { backgroundColor: "#2D7D5A", shadowColor: "#2D7D5A" },
  healthBtnLogged: { backgroundColor: "#1A5C3F" },
  mapBtn: { backgroundColor: COLORS.textMid, shadowColor: COLORS.textMid },
  actionBtnText: { color: "#fff", fontSize: 13, fontWeight: "700" },

  scanAgainBtn: { borderWidth: 2, borderColor: COLORS.red, borderRadius: 18, paddingVertical: 15, alignItems: "center", marginBottom: 8, backgroundColor: COLORS.white },
  scanAgainText: { color: COLORS.red, fontSize: 15, fontWeight: "700" },

  header: { marginBottom: 14 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },

  title: { fontSize: 28, fontFamily: "Nunito_800ExtraBold", color: COLORS.red, letterSpacing: -0.5 },
  subtitle: { fontSize: 12, fontFamily: "Nunito_600SemiBold", color: COLORS.textMid, marginTop: 1 },

  historyBtn: {
    alignItems: "center", justifyContent: "center", backgroundColor: COLORS.white,
    borderRadius: 20, width: 44, height: 44, borderWidth: 2, borderColor: COLORS.border,
    shadowColor: COLORS.red, shadowOpacity: 0.1, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
  },
  historyBtnText: { fontSize: 20 },
  historyBadge: {
    position: "absolute", top: -4, right: -4, backgroundColor: COLORS.orange,
    borderRadius: 10, minWidth: 18, height: 18, alignItems: "center", justifyContent: "center",
    paddingHorizontal: 4, borderWidth: 2, borderColor: COLORS.bg,
  },
  historyBadgeText: { fontSize: 9, color: "#fff", fontWeight: "800" },

  section: {
    backgroundColor: COLORS.white, borderRadius: 20, padding: 16, marginBottom: 14,
    shadowColor: COLORS.red, shadowOpacity: 0.07, shadowRadius: 12, shadowOffset: { width: 0, height: 3 },
    elevation: 3, borderWidth: 1, borderColor: COLORS.border,
  },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: COLORS.textDark, marginBottom: 12 },

  uploadRow: { flexDirection: "row", marginBottom: 4, gap: 10 },
  uploadBtn: {
    flex: 1, borderWidth: 2, borderColor: COLORS.border, borderStyle: "dashed", borderRadius: 16,
    paddingVertical: 22, alignItems: "center", backgroundColor: COLORS.redPale,
  },
  uploadIcon: { fontSize: 30, marginBottom: 6 },
  uploadBtnText: { fontSize: 12, color: COLORS.textMid, fontWeight: "600" },
  imagePreview: { width: "100%", height: 200, borderRadius: 16, marginBottom: 10 },
  changeBtn: { alignSelf: "center", marginBottom: 8 },
  changeBtnText: { fontSize: 13, color: COLORS.red, fontWeight: "600" },

  inputLabel: { fontSize: 11, color: COLORS.textMid, fontWeight: "600", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  input: {
    borderWidth: 1.5, borderColor: COLORS.border, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 11, fontSize: 14, color: COLORS.textDark, backgroundColor: COLORS.white,
  },
  inputRequired: { borderColor: COLORS.orange },

  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 1.5, borderColor: COLORS.border, backgroundColor: COLORS.white },
  pillActive: { backgroundColor: COLORS.red, borderColor: COLORS.red },
  pillText: { fontSize: 13, color: COLORS.textMid, fontWeight: "600" },
  pillTextActive: { color: "#fff" },

  divider: { height: 1.5, backgroundColor: COLORS.redPale, marginVertical: 14 },
  customLabel: { fontSize: 10, fontWeight: "700", color: COLORS.textLight, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 },
  addBtn: {
    marginTop: 10, backgroundColor: COLORS.orange, borderRadius: 12, paddingVertical: 12, alignItems: "center",
    shadowColor: COLORS.orange, shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
  },
  addBtnDisabled: { opacity: 0.4 },
  addBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  customPill: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 20, borderWidth: 1.5, borderColor: "#fdc99a", backgroundColor: COLORS.orangePale,
  },
  customPillText: { fontSize: 13, color: "#c2410c", fontWeight: "600" },
  removePill: { fontSize: 16, color: COLORS.orange, fontWeight: "700" },

  analyzeBtn: {
    backgroundColor: COLORS.red, borderRadius: 18, paddingVertical: 17, alignItems: "center", marginBottom: 24,
    shadowColor: COLORS.red, shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 6,
  },
  analyzeBtnDisabled: { opacity: 0.45 },
  analyzeBtnText: { color: "#fff", fontSize: 16, fontFamily: "Nunito_800ExtraBold", letterSpacing: 0.3 },

  dishName: { fontSize: 22, fontFamily: "Nunito_800ExtraBold", color: COLORS.textDark },
  confidence: { fontSize: 13, fontFamily: "Nunito_400Regular", color: COLORS.textMid, marginTop: 3 },
  warningBox: { marginTop: 12, backgroundColor: "#fffbeb", borderRadius: 12, padding: 12, borderWidth: 1.5, borderColor: "#fde68a" },
  warningTitle: { fontSize: 12, fontWeight: "700", color: "#b45309", marginBottom: 4 },
  warningText: { fontSize: 12, color: "#92400e", lineHeight: 18 },
  ingPill: { paddingHorizontal: 10, paddingVertical: 5, backgroundColor: COLORS.redPale, borderRadius: 12, borderWidth: 1, borderColor: COLORS.border },
  ingPillText: { fontSize: 12, color: COLORS.textMid, fontWeight: "500" },
  moreText: { fontSize: 12, color: COLORS.textLight, alignSelf: "center", fontWeight: "600" },

  card: {
    backgroundColor: COLORS.white, borderRadius: 18, padding: 14, borderWidth: 1.5, marginBottom: 12,
    shadowColor: COLORS.red, shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  cardTitle: { fontSize: 15, fontWeight: "700", color: COLORS.textDark },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderWidth: 1.5 },
  badgeText: { fontSize: 11, fontWeight: "700" },
  progressBg: { height: 8, backgroundColor: COLORS.redPale, borderRadius: 4, marginBottom: 6, overflow: "hidden" },
  progressFill: { height: 8, borderRadius: 4 },
  scoreText: { fontSize: 12, color: COLORS.textMid, marginBottom: 8, fontWeight: "500" },
  reasonRow: { flexDirection: "row", gap: 5, marginTop: 3 },
  bullet: { fontSize: 11, color: COLORS.textLight, marginTop: 1 },
  reasonText: { fontSize: 12, color: COLORS.textMid, flex: 1, lineHeight: 17 },

  swapsCard: {
    backgroundColor: "#E6F5EF", borderRadius: 18, padding: 14, borderWidth: 1.5,
    borderColor: "#7BC4A0", marginBottom: 12,
  },
  swapsTitle: { fontSize: 14, fontWeight: "700", color: "#1A5C3F" },
  swapRow: { flexDirection: "row", alignItems: "flex-start", marginBottom: 8 },
  swapAllergen: { fontSize: 13, fontWeight: "700", color: "#1A5C3F", minWidth: 70 },
  swapAlts: { fontSize: 13, color: "#2D5A40", flex: 1, lineHeight: 18 },

  disclaimer: { backgroundColor: COLORS.redPale, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: COLORS.border, marginTop: 4, marginBottom: 8 },
  disclaimerText: { fontSize: 11, color: COLORS.textMid, textAlign: "center", lineHeight: 16 },

  modalContainer: { flex: 1, backgroundColor: COLORS.bg },
  modalHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    padding: 20, paddingTop: 24, borderBottomWidth: 1.5, borderBottomColor: COLORS.border, backgroundColor: COLORS.white,
  },
  modalTitle: { fontSize: 18, fontWeight: "800", color: COLORS.textDark },
  doneBtn: { fontSize: 15, color: COLORS.red, fontWeight: "700" },
  clearBtn: { fontSize: 15, color: COLORS.orange, fontWeight: "600" },

  historyItem: {
    flexDirection: "row", alignItems: "center", backgroundColor: COLORS.white, borderRadius: 18,
    padding: 12, marginBottom: 10, shadowColor: COLORS.red, shadowOpacity: 0.06, shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 }, elevation: 2, gap: 12, borderWidth: 1, borderColor: COLORS.border,
  },
  historyThumb: { width: 56, height: 56, borderRadius: 12 },
  historyInfo: { flex: 1 },
  historyDish: { fontSize: 14, fontWeight: "700", color: COLORS.textDark },
  historyTime: { fontSize: 12, color: COLORS.textLight, marginTop: 2, fontWeight: "500" },
  emptyHistory: { textAlign: "center", color: COLORS.textLight, fontSize: 14, marginTop: 60, lineHeight: 22 },
});
