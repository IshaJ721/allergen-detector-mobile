import React, { useState, useEffect, useCallback } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { StatusBar } from "expo-status-bar";
import * as ImagePicker from "expo-image-picker";
import { readAsStringAsync, EncodingType } from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_ALLERGENS, Allergen } from "./lib/allergens";
import { scoreAllergen } from "./lib/scoring";
import {
  identifyDishFromImage,
  fetchAllIngredients,
  GROQ_API_KEY,
} from "./lib/apis";

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

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEYS = {
  ALLERGEN_SELECTIONS: "allergen_selections_v1",
  CUSTOM_ALLERGENS: "custom_allergens_v1",
  SCAN_HISTORY: "scan_history_v1",
};
const MAX_HISTORY = 10;
const RISK_ORDER: Record<string, number> = { High: 0, Likely: 1, Possible: 2, Low: 3 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function riskColors(risk: string) {
  switch (risk) {
    case "High":     return { bar: "#ef4444", badge: "#fee2e2", text: "#b91c1c", border: "#fca5a5" };
    case "Likely":   return { bar: "#f97316", badge: "#ffedd5", text: "#c2410c", border: "#fdba74" };
    case "Possible": return { bar: "#eab308", badge: "#fef9c3", text: "#a16207", border: "#fde047" };
    default:         return { bar: "#22c55e", badge: "#dcfce7", text: "#15803d", border: "#86efac" };
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

// ─── Allergen Card ────────────────────────────────────────────────────────────

function AllergenCard({
  name, score, risk, reason,
}: {
  name: string; score: number; risk: string; reason: string[];
}) {
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

// ─── History Item ─────────────────────────────────────────────────────────────

function HistoryItem({
  entry,
  onPress,
}: {
  entry: HistoryEntry;
  onPress: () => void;
}) {
  const risk = topRisk(entry.result.allergens);
  const c = riskColors(risk);
  return (
    <TouchableOpacity style={styles.historyItem} onPress={onPress} activeOpacity={0.7}>
      <Image source={{ uri: entry.imageUri }} style={styles.historyThumb} />
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

// ─── History Modal ────────────────────────────────────────────────────────────

function HistoryModal({
  visible,
  history,
  onClose,
  onSelect,
  onClear,
}: {
  visible: boolean;
  history: HistoryEntry[];
  onClose: () => void;
  onSelect: (entry: HistoryEntry) => void;
  onClear: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.modalContainer}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Scan History</Text>
          <View style={{ flexDirection: "row", gap: 12 }}>
            {history.length > 0 && (
              <TouchableOpacity onPress={onClear}>
                <Text style={styles.clearBtn}>Clear</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.doneBtn}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          {history.length === 0 ? (
            <Text style={styles.emptyHistory}>No scans yet. Analyze a food photo to get started.</Text>
          ) : (
            history.map((entry) => (
              <HistoryItem
                key={entry.id}
                entry={entry}
                onPress={() => { onSelect(entry); onClose(); }}
              />
            ))
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageMime, setImageMime] = useState("image/jpeg");

  const [dishName, setDishName] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [cuisineType, setCuisineType] = useState("");

  const [selectedAllergens, setSelectedAllergens] = useState<Set<string>>(
    new Set(DEFAULT_ALLERGENS.map((a) => a.id))
  );
  const [customAllergens, setCustomAllergens] = useState<
    { name: string; keywords: string[] }[]
  >([]);
  const [newName, setNewName] = useState("");
  const [newKeywords, setNewKeywords] = useState("");

  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // ── Persist & restore allergen prefs ──
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
      } catch {
        // ignore storage errors
      }
    })();
  }, []);

  const saveAllergenSelections = useCallback(async (selections: Set<string>) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.ALLERGEN_SELECTIONS, JSON.stringify([...selections]));
    } catch {}
  }, []);

  const saveCustomAllergens = useCallback(async (customs: { name: string; keywords: string[] }[]) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.CUSTOM_ALLERGENS, JSON.stringify(customs));
    } catch {}
  }, []);

  const saveHistory = useCallback(async (entries: HistoryEntry[]) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.SCAN_HISTORY, JSON.stringify(entries));
    } catch {}
  }, []);

  // ── Image picker ──
  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Please allow photo access.");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });
    if (!res.canceled && res.assets[0]) {
      setImageUri(res.assets[0].uri);
      setImageMime(res.assets[0].mimeType || "image/jpeg");
      setResult(null);
    }
  };

  const takePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Please allow camera access.");
      return;
    }
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
      const next = [
        ...prev,
        { name, keywords: keywords.length ? keywords : [name.toLowerCase()] },
      ];
      saveCustomAllergens(next);
      return next;
    });
    setNewName("");
    setNewKeywords("");
  };

  const removeCustomAllergen = (index: number) => {
    setCustomAllergens((prev) => {
      const next = prev.filter((_, j) => j !== index);
      saveCustomAllergens(next);
      return next;
    });
  };

  // ── Analyze ──
  const handleAnalyze = async () => {
    if (!imageUri) return;
    if (!GROQ_API_KEY) {
      Alert.alert("API Key Missing", "Add your Groq API key in lib/apis.ts");
      return;
    }
    setLoading(true);
    try {
      const base64 = await readAsStringAsync(imageUri, {
        encoding: EncodingType.Base64,
      });

      const visionResult = await identifyDishFromImage(
        base64,
        imageMime,
        dishName.trim() || undefined,
        restaurantName.trim() || undefined,
        cuisineType.trim() || undefined
      );

      const resolvedDish = dishName.trim() || visionResult.dish;
      const recipeData = await fetchAllIngredients(resolvedDish);
      const allIngredients = [
        ...new Set([...visionResult.visibleIngredients, ...recipeData.ingredients]),
      ];

      const allergensToScore: Allergen[] = [
        ...DEFAULT_ALLERGENS.filter((a) => selectedAllergens.has(a.id)),
        ...customAllergens.map((ca, i) => ({
          id: `custom_${i}`,
          name: ca.name,
          keywords: ca.keywords,
          custom: true,
        })),
      ];

      const allergenResults: Record<string, AllergenResult> = {};
      for (const allergen of allergensToScore) {
        let maxFreq = 0;
        for (const kw of allergen.keywords) {
          const kwNorm = kw.toLowerCase();
          for (const [ing, freq] of Object.entries(recipeData.ingredientFrequencies)) {
            if (ing.includes(kwNorm) || kwNorm.includes(ing)) {
              maxFreq = Math.max(maxFreq, freq);
            }
          }
        }
        allergenResults[allergen.id] = scoreAllergen({
          allergen,
          visionConfidence: visionResult.visionConfidence,
          visibleIngredients: visionResult.visibleIngredients,
          recipeIngredients: recipeData.ingredients,
          ingredientFrequency: maxFreq,
          dishName: resolvedDish,
        });
      }

      const newResult: AnalysisResult = {
        dish: resolvedDish,
        visionConfidence: visionResult.visionConfidence,
        visibleIngredients: visionResult.visibleIngredients,
        uncertaintyNotes: visionResult.uncertaintyNotes,
        ingredients: allIngredients,
        allergens: allergenResults,
      };

      setResult(newResult);

      // Save to history
      if (imageUri) {
        const entry: HistoryEntry = {
          id: Date.now().toString(),
          timestamp: Date.now(),
          imageUri,
          result: newResult,
        };
        setHistory((prev) => {
          const next = [entry, ...prev].slice(0, MAX_HISTORY);
          saveHistory(next);
          return next;
        });
      }
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const loadHistoryEntry = (entry: HistoryEntry) => {
    setImageUri(entry.imageUri);
    setResult(entry.result);
    setDishName(entry.result.dish);
  };

  const clearHistory = () => {
    Alert.alert("Clear History", "Remove all saved scans?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          setHistory([]);
          saveHistory([]);
        },
      },
    ]);
  };

  // Sort allergens for display: High → Likely → Possible → Low
  const displayAllergens: Allergen[] = [
    ...DEFAULT_ALLERGENS.filter((a) => selectedAllergens.has(a.id)),
    ...customAllergens.map((ca, i) => ({
      id: `custom_${i}`,
      name: ca.name,
      keywords: ca.keywords,
      custom: true,
    })),
  ];

  const sortedDisplayAllergens = result
    ? [...displayAllergens].sort((a, b) => {
        const ra = result.allergens[a.id]?.risk ?? "Low";
        const rb = result.allergens[b.id]?.risk ?? "Low";
        return (RISK_ORDER[ra] ?? 3) - (RISK_ORDER[rb] ?? 3);
      })
    : displayAllergens;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <StatusBar style="dark" />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <Text style={styles.title}>Food Allergen Detector</Text>
            <TouchableOpacity style={styles.historyBtn} onPress={() => setShowHistory(true)}>
              <Text style={styles.historyBtnText}>History</Text>
              {history.length > 0 && (
                <View style={styles.historyBadge}>
                  <Text style={styles.historyBadgeText}>{history.length}</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
          <Text style={styles.subtitle}>
            Upload a photo to estimate allergen risks using AI + recipe data
          </Text>
        </View>

        {/* Image upload */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>1. Food Image</Text>
          {imageUri ? (
            <>
              <Image
                source={{ uri: imageUri }}
                style={styles.imagePreview}
                resizeMode="cover"
              />
              <Pressable style={styles.changeBtn} onPress={pickImage}>
                <Text style={styles.changeBtnText}>Change Photo</Text>
              </Pressable>
            </>
          ) : (
            <View style={styles.uploadRow}>
              <TouchableOpacity style={styles.uploadBtn} onPress={pickImage}>
                <Text style={styles.uploadIcon}>🖼️</Text>
                <Text style={styles.uploadBtnText}>Photo Library</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.uploadBtn, { marginLeft: 12 }]}
                onPress={takePhoto}
              >
                <Text style={styles.uploadIcon}>📷</Text>
                <Text style={styles.uploadBtnText}>Camera</Text>
              </TouchableOpacity>
            </View>
          )}

          <View style={{ marginTop: 12 }}>
            {(
              [
                { label: "Dish name (optional)", value: dishName, setter: setDishName, placeholder: "e.g. Pad Thai" },
                { label: "Restaurant (optional)", value: restaurantName, setter: setRestaurantName, placeholder: "e.g. Thai Garden" },
                { label: "Cuisine type (optional)", value: cuisineType, setter: setCuisineType, placeholder: "e.g. Thai" },
              ] as const
            ).map(({ label, value, setter, placeholder }) => (
              <View key={label} style={{ marginBottom: 10 }}>
                <Text style={styles.inputLabel}>{label}</Text>
                <TextInput
                  style={styles.input}
                  value={value}
                  onChangeText={setter}
                  placeholder={placeholder}
                  placeholderTextColor="#9ca3af"
                />
              </View>
            ))}
          </View>
        </View>

        {/* Allergen selection */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>2. Allergens to Check</Text>
          <View style={styles.pillRow}>
            {DEFAULT_ALLERGENS.map((a) => (
              <TouchableOpacity
                key={a.id}
                style={[styles.pill, selectedAllergens.has(a.id) && styles.pillActive]}
                onPress={() => toggleAllergen(a.id)}
              >
                <Text style={[styles.pillText, selectedAllergens.has(a.id) && styles.pillTextActive]}>
                  {a.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.divider} />
          <Text style={styles.customLabel}>Custom Allergens</Text>

          <TextInput
            style={styles.input}
            value={newName}
            onChangeText={setNewName}
            placeholder="Allergen name (e.g. Mustard)"
            placeholderTextColor="#9ca3af"
          />
          <TextInput
            style={[styles.input, { marginTop: 8 }]}
            value={newKeywords}
            onChangeText={setNewKeywords}
            placeholder="Keywords, comma-separated (optional)"
            placeholderTextColor="#9ca3af"
          />
          <TouchableOpacity
            style={[styles.addBtn, !newName.trim() && styles.addBtnDisabled]}
            onPress={addCustomAllergen}
            disabled={!newName.trim()}
          >
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
          style={[
            styles.analyzeBtn,
            (!imageUri || loading) && styles.analyzeBtnDisabled,
          ]}
          onPress={handleAnalyze}
          disabled={!imageUri || loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.analyzeBtnText}>Analyze for Allergens</Text>
          )}
        </TouchableOpacity>

        {/* Results */}
        {result && (
          <View>
            <View style={styles.section}>
              <Text style={styles.dishName}>{result.dish}</Text>
              <Text style={styles.confidence}>
                Vision confidence: {Math.round(result.visionConfidence * 100)}%
              </Text>

              {result.uncertaintyNotes?.length > 0 && (
                <View style={styles.warningBox}>
                  <Text style={styles.warningTitle}>Uncertainty Notes</Text>
                  {result.uncertaintyNotes.map((n, i) => (
                    <Text key={i} style={styles.warningText}>• {n}</Text>
                  ))}
                </View>
              )}

              {result.ingredients?.length > 0 && (
                <View style={{ marginTop: 12 }}>
                  <Text style={styles.customLabel}>Detected / Inferred Ingredients</Text>
                  <View style={styles.pillRow}>
                    {result.ingredients.slice(0, 25).map((ing) => (
                      <View key={ing} style={styles.ingPill}>
                        <Text style={styles.ingPillText}>{ing}</Text>
                      </View>
                    ))}
                    {result.ingredients.length > 25 && (
                      <Text style={styles.moreText}>+{result.ingredients.length - 25} more</Text>
                    )}
                  </View>
                </View>
              )}
            </View>

            <Text style={[styles.sectionTitle, { marginBottom: 8 }]}>
              Allergen Risk Assessment
            </Text>
            {sortedDisplayAllergens.map((a) => {
              const data = result.allergens[a.id];
              if (!data) return null;
              return (
                <AllergenCard
                  key={a.id}
                  name={a.name}
                  score={data.score}
                  risk={data.risk}
                  reason={data.reason}
                />
              );
            })}

            <View style={styles.disclaimer}>
              <Text style={styles.disclaimerText}>
                Estimates only. Not guaranteed for medical safety. Always consult
                ingredient labels and restaurant staff if you have severe allergies.
              </Text>
            </View>
          </View>
        )}
      </ScrollView>

      {/* History Modal */}
      <HistoryModal
        visible={showHistory}
        history={history}
        onClose={() => setShowHistory(false)}
        onSelect={loadHistoryEntry}
        onClear={clearHistory}
      />
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f8fafc" },
  content: { padding: 20, paddingTop: 64, paddingBottom: 48 },

  header: { marginBottom: 24 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 24, fontWeight: "700", color: "#0f172a", flex: 1 },
  subtitle: { fontSize: 13, color: "#64748b", marginTop: 6, lineHeight: 19 },

  historyBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f1f5f9",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    gap: 6,
  },
  historyBtnText: { fontSize: 13, fontWeight: "600", color: "#374151" },
  historyBadge: {
    backgroundColor: "#2563eb",
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  historyBadgeText: { fontSize: 10, color: "#fff", fontWeight: "700" },

  section: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  sectionTitle: { fontSize: 15, fontWeight: "600", color: "#374151", marginBottom: 12 },

  uploadRow: { flexDirection: "row", marginBottom: 4 },
  uploadBtn: {
    flex: 1,
    borderWidth: 2,
    borderColor: "#e2e8f0",
    borderStyle: "dashed",
    borderRadius: 12,
    paddingVertical: 24,
    alignItems: "center",
    backgroundColor: "#f8fafc",
  },
  uploadIcon: { fontSize: 28, marginBottom: 6 },
  uploadBtnText: { fontSize: 13, color: "#64748b", fontWeight: "500" },
  imagePreview: { width: "100%", height: 200, borderRadius: 12, marginBottom: 10 },
  changeBtn: { alignSelf: "center", marginBottom: 8 },
  changeBtnText: { fontSize: 13, color: "#2563eb", fontWeight: "500" },

  inputLabel: { fontSize: 12, color: "#6b7280", fontWeight: "500", marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: "#111827",
    backgroundColor: "#fff",
  },

  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#d1d5db",
    backgroundColor: "#fff",
  },
  pillActive: { backgroundColor: "#2563eb", borderColor: "#2563eb" },
  pillText: { fontSize: 13, color: "#4b5563", fontWeight: "500" },
  pillTextActive: { color: "#fff" },

  divider: { height: 1, backgroundColor: "#f1f5f9", marginVertical: 14 },
  customLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#9ca3af",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  addBtn: {
    marginTop: 10,
    backgroundColor: "#2563eb",
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center",
  },
  addBtnDisabled: { opacity: 0.4 },
  addBtnText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  customPill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#c4b5fd",
    backgroundColor: "#f5f3ff",
  },
  customPillText: { fontSize: 13, color: "#7c3aed", fontWeight: "500" },
  removePill: { fontSize: 16, color: "#a78bfa", fontWeight: "700" },

  analyzeBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    marginBottom: 24,
    shadowColor: "#2563eb",
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  analyzeBtnDisabled: { opacity: 0.45 },
  analyzeBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },

  dishName: { fontSize: 22, fontWeight: "700", color: "#0f172a" },
  confidence: { fontSize: 13, color: "#64748b", marginTop: 2 },
  warningBox: {
    marginTop: 12,
    backgroundColor: "#fffbeb",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: "#fde68a",
  },
  warningTitle: { fontSize: 12, fontWeight: "700", color: "#b45309", marginBottom: 4 },
  warningText: { fontSize: 12, color: "#92400e", lineHeight: 18 },
  ingPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: "#f1f5f9",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  ingPillText: { fontSize: 12, color: "#475569" },
  moreText: { fontSize: 12, color: "#9ca3af", alignSelf: "center" },

  card: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    marginBottom: 12,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  cardTitle: { fontSize: 15, fontWeight: "600", color: "#1e293b" },
  badge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20, borderWidth: 1 },
  badgeText: { fontSize: 11, fontWeight: "600" },
  progressBg: {
    height: 10,
    backgroundColor: "#f1f5f9",
    borderRadius: 5,
    marginBottom: 6,
    overflow: "hidden",
  },
  progressFill: { height: 10, borderRadius: 5 },
  scoreText: { fontSize: 12, color: "#64748b", marginBottom: 8 },
  reasonRow: { flexDirection: "row", gap: 5, marginTop: 3 },
  bullet: { fontSize: 11, color: "#94a3b8", marginTop: 1 },
  reasonText: { fontSize: 12, color: "#475569", flex: 1, lineHeight: 17 },

  disclaimer: {
    backgroundColor: "#f8fafc",
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    marginTop: 4,
    marginBottom: 8,
  },
  disclaimerText: { fontSize: 11, color: "#64748b", textAlign: "center", lineHeight: 16 },

  // History modal
  modalContainer: { flex: 1, backgroundColor: "#f8fafc" },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 20,
    paddingTop: 24,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
    backgroundColor: "#fff",
  },
  modalTitle: { fontSize: 18, fontWeight: "700", color: "#0f172a" },
  doneBtn: { fontSize: 15, color: "#2563eb", fontWeight: "600" },
  clearBtn: { fontSize: 15, color: "#ef4444", fontWeight: "500" },

  historyItem: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
    gap: 12,
  },
  historyThumb: { width: 56, height: 56, borderRadius: 10 },
  historyInfo: { flex: 1 },
  historyDish: { fontSize: 14, fontWeight: "600", color: "#1e293b" },
  historyTime: { fontSize: 12, color: "#94a3b8", marginTop: 2 },
  emptyHistory: {
    textAlign: "center",
    color: "#94a3b8",
    fontSize: 14,
    marginTop: 60,
    lineHeight: 22,
  },
});
