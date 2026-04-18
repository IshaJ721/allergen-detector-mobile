import React, { useState, useRef, useCallback } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView as RNScrollView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { Feather } from "@expo/vector-icons";
import { DEFAULT_ALLERGENS } from "../lib/allergens";
import { scoreAllergen } from "../lib/scoring";
import { analyzeDishFromName, fetchAllIngredients, fetchRestaurantMenuInfo, fetchRestaurantMenuItems, fetchSafeAlternatives, AllergenSwap, RestaurantMenuInfo } from "../lib/apis";

let MapView: any = null;
let Marker: any = null;
try {
  const maps = require("react-native-maps");
  MapView = maps.default;
  Marker = maps.Marker;
} catch {}

const GOOGLE_KEY = process.env.EXPO_PUBLIC_GOOGLE_PLACES_KEY ?? "";

const COLORS = {
  red: "#BA3801", orange: "#D45A0A", white: "#ffffff", bg: "#FFFDF5",
  textDark: "#1C2B38", textMid: "#4A6983", textLight: "#8FAEC2",
  border: "#FFE0A0", redPale: "#FFF4E6", green: "#2D7D5A",
};
const SCREEN_W = Dimensions.get("window").width;
const STORAGE_KEY = "safety_map_restaurants_v3";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SavedRestaurant {
  id: string;
  name: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  safeAllergens: string[];
  riskyAllergens: string[];
  riskLevel: "Safe" | "Caution" | "Avoid";
  notes?: string;
  addedAt: number;
}

interface GooglePlace {
  place_id: string;
  name: string;
  formatted_address: string;
  vicinity?: string;
  rating?: number;
  user_ratings_total?: number;
  geometry: { location: { lat: number; lng: number } };
  photos?: { name: string }[];
  types?: string[];
  opening_hours?: { open_now?: boolean };
  distanceM?: number;
}

interface AllergenResult { score: number; risk: string; reason: string[] }

// ── Helpers ───────────────────────────────────────────────────────────────────

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000, dLat = ((lat2 - lat1) * Math.PI) / 180, dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDist(m: number) { return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`; }

function placePhotoUrl(name: string) {
  return `https://places.googleapis.com/v1/${name}/media?maxWidthPx=120&key=${GOOGLE_KEY}`;
}

function placeTypeIcon(types?: string[]): string {
  if (!types) return "map-pin";
  if (types.includes("cafe")) return "coffee";
  if (types.includes("bar")) return "music";
  if (types.includes("bakery")) return "sun";
  if (types.includes("meal_takeaway") || types.includes("fast_food")) return "shopping-bag";
  return "map-pin";
}

function riskLevelColor(level: string) {
  switch (level) { case "Safe": return "#2D7D5A"; case "Caution": return "#B08800"; case "Avoid": return "#BA3801"; default: return "#4A6983"; }
}

function riskIcon(level: string): { name: string; color: string } {
  switch (level) {
    case "Safe":    return { name: "check-circle", color: "#2D7D5A" };
    case "Caution": return { name: "alert-triangle", color: "#B08800" };
    case "Avoid":   return { name: "x-circle", color: "#BA3801" };
    default:        return { name: "help-circle", color: "#4A6983" };
  }
}

function riskBarColor(risk: string) {
  switch (risk) { case "High": return "#BA3801"; case "Likely": return "#D45A0A"; case "Possible": return "#B08800"; default: return "#2D7D5A"; }
}

async function searchPlaces(query: string, lat: number, lon: number): Promise<GooglePlace[]> {
  if (!GOOGLE_KEY) throw new Error("Google Places API key not set. Add EXPO_PUBLIC_GOOGLE_PLACES_KEY to your .env file.");
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.photos,places.types,places.currentOpeningHours",
    },
    body: JSON.stringify({
      textQuery: query,
      maxResultCount: 10,
      locationBias: { circle: { center: { latitude: lat, longitude: lon }, radius: 8000.0 } },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message ?? "Google Places error");
  return ((data.places ?? []) as any[]).map((p: any) => ({
    place_id: p.id,
    name: p.displayName?.text ?? "",
    formatted_address: p.formattedAddress ?? "",
    rating: p.rating,
    user_ratings_total: p.userRatingCount,
    geometry: { location: { lat: p.location.latitude, lng: p.location.longitude } },
    photos: p.photos?.slice(0, 1).map((ph: any) => ({ name: ph.name })),
    types: p.types,
    opening_hours: p.currentOpeningHours ? { open_now: p.currentOpeningHours.openNow } : undefined,
    distanceM: haversineM(lat, lon, p.location.latitude, p.location.longitude),
  } as GooglePlace)).sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0));
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface MapAnalysisEntry {
  dish: string;
  restaurant: string;
  allergens: Record<string, { score: number; risk: string; reason: string[] }>;
}

interface Props {
  selectedAllergens: Set<string>;
  customAllergens: { name: string; keywords: string[] }[];
  pendingRestaurant?: { name: string; riskyAllergens: string[]; safeAllergens: string[]; riskLevel: "Safe" | "Caution" | "Avoid" } | null;
  onPendingConsumed?: () => void;
  onAnalysisComplete?: (entry: MapAnalysisEntry) => void;
  pendingSearch?: string | null;
  onPendingSearchConsumed?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SafetyMapScreen({ selectedAllergens, customAllergens, pendingRestaurant, onPendingConsumed, onAnalysisComplete, pendingSearch, onPendingSearchConsumed }: Props) {
  const [userLocation, setUserLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [mapRegion, setMapRegion] = useState({ latitude: 37.7749, longitude: -122.4194, latitudeDelta: 0.05, longitudeDelta: 0.05 });
  const mapRef = useRef<any>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<GooglePlace[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selectedPlace, setSelectedPlace] = useState<GooglePlace | null>(null);
  const [dishInput, setDishInput] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [allergenResults, setAllergenResults] = useState<Record<string, AllergenResult> | null>(null);
  const [menuInfo, setMenuInfo] = useState<RestaurantMenuInfo | null>(null);
  const [swaps, setSwaps] = useState<AllergenSwap[]>([]);
  const [menuItems, setMenuItems] = useState<string[]>([]);
  const [menuItemsLoading, setMenuItemsLoading] = useState(false);

  const [saved, setSaved] = useState<SavedRestaurant[]>([]);
  const [selectedSaved, setSelectedSaved] = useState<SavedRestaurant | null>(null);
  const [showAllSaved, setShowAllSaved] = useState(false);

  // ── Init ──
  React.useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => { if (raw) setSaved(JSON.parse(raw)); });
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") return;
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const { latitude, longitude } = loc.coords;
        setUserLocation({ lat: latitude, lon: longitude });
        mapRef.current?.animateToRegion({ latitude, longitude, latitudeDelta: 0.03, longitudeDelta: 0.03 }, 600);
      } catch {}
    })();
  }, []);

  React.useEffect(() => {
    if (pendingSearch && userLocation) {
      setSearchQuery(pendingSearch);
      runSearch(pendingSearch);
      onPendingSearchConsumed?.();
    }
  }, [pendingSearch, userLocation]);

  React.useEffect(() => {
    if (pendingRestaurant) {
      const entry: SavedRestaurant = {
        id: Date.now().toString(),
        name: pendingRestaurant.name,
        safeAllergens: pendingRestaurant.safeAllergens,
        riskyAllergens: pendingRestaurant.riskyAllergens,
        riskLevel: pendingRestaurant.riskLevel,
        notes: pendingRestaurant.riskyAllergens.length ? `Risky: ${pendingRestaurant.riskyAllergens.join(", ")}` : undefined,
        addedAt: Date.now(),
      };
      const next = [entry, ...saved];
      setSaved(next);
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      onPendingConsumed?.();
    }
  }, [pendingRestaurant]);

  const persistSaved = useCallback((list: SavedRestaurant[]) => {
    setSaved(list);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }, []);

  // ── Search (debounced) ──
  const runSearch = useCallback(async (query: string) => {
    if (!query.trim() || !userLocation) return;
    setSearching(true);
    setHasSearched(true);
    setSelectedPlace(null);
    setAllergenResults(null);
    setMenuInfo(null);
    setDishInput("");
    try {
      const results = await searchPlaces(query.trim(), userLocation.lat, userLocation.lon);
      setSearchResults(results);
      if (results.length > 0) {
        const { lat, lng } = results[0].geometry.location;
        mapRef.current?.animateToRegion({ latitude: lat, longitude: lng, latitudeDelta: 0.04, longitudeDelta: 0.04 }, 600);
      }
    } catch (e: any) {
      Alert.alert("Search failed", e.message ?? "Could not reach Google Places.");
    } finally {
      setSearching(false);
    }
  }, [userLocation]);

  const onSearchChange = (text: string) => {
    setSearchQuery(text);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (text.trim().length < 2) { setSearchResults([]); setHasSearched(false); return; }
    searchDebounce.current = setTimeout(() => runSearch(text), 500);
  };

  const selectPlace = (place: GooglePlace) => {
    setSelectedPlace(place);
    setAllergenResults(null);
    setMenuInfo(null);
    setSwaps([]);
    setDishInput("");
    setMenuItems([]);
    const { lat, lng } = place.geometry.location;
    mapRef.current?.animateToRegion({ latitude: lat, longitude: lng, latitudeDelta: 0.008, longitudeDelta: 0.008 }, 500);
    setMenuItemsLoading(true);
    fetchRestaurantMenuItems(place.name).then((items) => {
      setMenuItems(items);
      setMenuItemsLoading(false);
    }).catch(() => setMenuItemsLoading(false));
  };

  // ── Analyze ──
  const handleAnalyze = async () => {
    if (!selectedPlace || !dishInput.trim()) return;
    setAnalyzing(true);
    setMenuInfo(null);
    try {
      const [visionResult, menuData] = await Promise.all([
        analyzeDishFromName(dishInput.trim(), selectedPlace.name),
        fetchRestaurantMenuInfo(dishInput.trim(), selectedPlace.name),
      ]);
      const recipeData = await fetchAllIngredients(dishInput.trim(), [...visionResult.visibleIngredients, ...visionResult.hiddenIngredients, ...menuData.dishIngredients]);

      setMenuInfo(menuData);

      const allergensToScore = [
        ...DEFAULT_ALLERGENS.filter((a) => selectedAllergens.has(a.id)),
        ...customAllergens.map((ca, i) => ({ id: `custom_${i}`, name: ca.name, keywords: ca.keywords, custom: true })),
      ];

      const allIngredients = [...new Set([...visionResult.visibleIngredients, ...visionResult.hiddenIngredients, ...menuData.dishIngredients, ...recipeData.ingredients])];

      const scored: Record<string, AllergenResult> = {};
      for (const allergen of allergensToScore) {
        const confirmedPresent = menuData.confirmedAllergens.includes(allergen.id);
        const confirmedSafe = menuData.confirmedSafe.includes(allergen.id);

        let maxFreq = confirmedPresent ? 1.0 : 0;
        if (!confirmedSafe) {
          for (const kw of allergen.keywords) {
            for (const [ing, freq] of Object.entries(recipeData.ingredientFrequencies)) {
              if (ing.includes(kw.toLowerCase()) || kw.toLowerCase().includes(ing)) maxFreq = Math.max(maxFreq, freq as number);
            }
          }
        }

        scored[allergen.id] = scoreAllergen({
          allergen,
          visionConfidence: visionResult.visionConfidence,
          visibleIngredients: [...visionResult.visibleIngredients, ...menuData.dishIngredients],
          hiddenIngredients: visionResult.hiddenIngredients,
          recipeIngredients: allIngredients,
          ingredientFrequency: maxFreq,
          dishName: dishInput.trim(),
          allergenFlag: visionResult.allergenFlags?.[allergen.id],
          restaurantConfirmedPresent: confirmedPresent,
          restaurantConfirmedSafe: confirmedSafe,
          restaurantConfidence: menuData.confidence,
        });
      }
      setAllergenResults(scored);
      onAnalysisComplete?.({ dish: dishInput.trim(), restaurant: selectedPlace.name, allergens: scored });

      const riskyNames = allergensToScore
        .filter((a) => scored[a.id]?.risk === "High" || scored[a.id]?.risk === "Likely")
        .map((a) => a.name);
      if (riskyNames.length > 0) {
        fetchSafeAlternatives(dishInput.trim(), riskyNames, allIngredients).then(setSwaps);
      }
    } catch (e: any) {
      Alert.alert("Analysis failed", e.message ?? "Something went wrong");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleSaveResult = () => {
    if (!selectedPlace || !allergenResults) return;
    const ORDER: Record<string, number> = { High: 0, Likely: 1, Possible: 2, Low: 3 };
    const worst = Object.values(allergenResults).reduce((b, v) => (ORDER[v.risk] ?? 3) < (ORDER[b] ?? 3) ? v.risk : b, "Low");
    const riskLevel: SavedRestaurant["riskLevel"] = worst === "High" || worst === "Likely" ? "Avoid" : worst === "Possible" ? "Caution" : "Safe";
    const riskyAllergens = Object.entries(allergenResults).filter(([, v]) => v.risk === "High" || v.risk === "Likely").map(([id]) => DEFAULT_ALLERGENS.find((a) => a.id === id)?.name ?? id);
    const safeAllergens = Object.entries(allergenResults).filter(([, v]) => v.risk === "Low").map(([id]) => DEFAULT_ALLERGENS.find((a) => a.id === id)?.name ?? id);
    const entry: SavedRestaurant = {
      id: Date.now().toString(),
      name: selectedPlace.name,
      address: selectedPlace.formatted_address ?? selectedPlace.vicinity,
      latitude: selectedPlace.geometry.location.lat,
      longitude: selectedPlace.geometry.location.lng,
      safeAllergens, riskyAllergens, riskLevel,
      notes: `${dishInput}${riskyAllergens.length ? ` — Risky: ${riskyAllergens.join(", ")}` : " — No major risks"}`,
      addedAt: Date.now(),
    };
    persistSaved([entry, ...saved]);
    Alert.alert("Saved!", `${selectedPlace.name} added to your safety map.`);
  };

  const openInMaps = (r: SavedRestaurant) => {
    const q = encodeURIComponent(r.address ? `${r.name}, ${r.address}` : r.name);
    Linking.openURL(`maps://?q=${q}`).catch(() => Linking.openURL(`https://maps.apple.com/?q=${q}`));
  };

  const sortedAllergens = allergenResults
    ? [...DEFAULT_ALLERGENS.filter((a) => selectedAllergens.has(a.id)), ...customAllergens.map((ca, i) => ({ id: `custom_${i}`, name: ca.name, keywords: ca.keywords }))]
        .filter((a) => allergenResults[a.id])
        .sort((a, b) => { const o: Record<string, number> = { High: 0, Likely: 1, Possible: 2, Low: 3 }; return (o[allergenResults[a.id].risk] ?? 3) - (o[allergenResults[b.id].risk] ?? 3); })
    : [];

  return (
    <View style={{ flex: 1, backgroundColor: COLORS.bg }}>

      {/* Map */}
      {MapView ? (
        <MapView ref={mapRef} style={s.map} region={mapRegion} onRegionChangeComplete={(r: any) => setMapRegion(r)} showsUserLocation showsMyLocationButton={false}>
          {searchResults.map((r) => (
            <Marker key={r.place_id} coordinate={{ latitude: r.geometry.location.lat, longitude: r.geometry.location.lng }}
              pinColor={selectedPlace?.place_id === r.place_id ? COLORS.red : COLORS.textMid} onPress={() => selectPlace(r)} />
          ))}
          {saved.filter((r) => r.latitude && r.longitude).map((r) => (
            <Marker key={r.id} coordinate={{ latitude: r.latitude!, longitude: r.longitude! }}
              pinColor={riskLevelColor(r.riskLevel)} title={r.name} onPress={() => setSelectedSaved(r)} />
          ))}
        </MapView>
      ) : (
        <View style={s.mapPlaceholder}>
          <Feather name="map" size={36} color={COLORS.textMid} />
        </View>
      )}

      {/* Locate me */}
      <TouchableOpacity style={s.locateBtn} onPress={() => {
        if (userLocation) mapRef.current?.animateToRegion({ latitude: userLocation.lat, longitude: userLocation.lon, latitudeDelta: 0.03, longitudeDelta: 0.03 }, 500);
      }}>
        <Feather name={userLocation ? "navigation" : "clock"} size={18} color={COLORS.textMid} />
      </TouchableOpacity>

      {/* Search bar */}
      <View style={s.searchBar}>
        <Feather name="search" size={16} color={COLORS.textLight} style={{ marginRight: 4 }} />
        <TextInput style={s.searchInput} value={searchQuery} onChangeText={onSearchChange}
          placeholder="Search restaurant or café…" placeholderTextColor={COLORS.textLight}
          returnKeyType="search" onSubmitEditing={() => runSearch(searchQuery)} />
        {searching
          ? <ActivityIndicator color={COLORS.red} size="small" style={{ marginRight: 4 }} />
          : searchQuery.length > 0
            ? <TouchableOpacity onPress={() => { setSearchQuery(""); setSearchResults([]); setHasSearched(false); }}>
                <Feather name="x" size={18} color={COLORS.textLight} style={{ paddingHorizontal: 4 }} />
              </TouchableOpacity>
            : null}
      </View>

      {!userLocation && (
        <View style={s.banner}>
          <Feather name="map-pin" size={12} color="#1d4ed8" style={{ marginRight: 4 }} />
          <Text style={s.bannerText}>Getting your location…</Text>
        </View>
      )}

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">

        {/* No results */}
        {hasSearched && !searching && searchResults.length === 0 && (
          <View style={{ padding: 24, alignItems: "center" }}>
            <Text style={{ fontSize: 13, color: COLORS.textLight, textAlign: "center" }}>No results for "{searchQuery}" nearby.</Text>
          </View>
        )}

        {/* Results list */}
        {searchResults.length > 0 && !selectedPlace && (
          <View style={s.section}>
            <Text style={s.sectionLabel}>{searchResults.length} nearby result{searchResults.length !== 1 ? "s" : ""}</Text>
            {searchResults.slice(0, 10).map((r) => (
              <TouchableOpacity key={r.place_id} style={s.placeRow} onPress={() => selectPlace(r)} activeOpacity={0.75}>
                {r.photos?.[0] ? (
                  <Image source={{ uri: placePhotoUrl(r.photos[0].name) }} style={s.placePhoto} />
                ) : (
                  <View style={s.placePhotoPlaceholder}>
                    <Feather name={placeTypeIcon(r.types) as any} size={22} color={COLORS.textMid} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={s.placeName} numberOfLines={1}>{r.name}</Text>
                  <Text style={s.placeAddr} numberOfLines={1}>{r.vicinity ?? r.formatted_address}</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 3 }}>
                    {r.rating != null && (
                      <Text style={s.placeRating}>
                        <Feather name="star" size={11} color={COLORS.orange} /> {r.rating.toFixed(1)}{r.user_ratings_total ? ` (${r.user_ratings_total > 999 ? `${(r.user_ratings_total / 1000).toFixed(1)}k` : r.user_ratings_total})` : ""}
                      </Text>
                    )}
                    {r.opening_hours?.open_now != null && (
                      <Text style={[s.openStatus, { color: r.opening_hours.open_now ? COLORS.green : COLORS.red }]}>
                        {r.opening_hours.open_now ? "Open" : "Closed"}
                      </Text>
                    )}
                  </View>
                </View>
                <Text style={s.placeDist}>{formatDist(r.distanceM ?? 0)}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Selected place panel */}
        {selectedPlace && (
          <View style={s.section}>
            {/* Header */}
            <View style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: 12 }}>
              {selectedPlace.photos?.[0] ? (
                <Image source={{ uri: placePhotoUrl(selectedPlace.photos[0].name) }} style={s.selectedPhoto} />
              ) : (
                <View style={[s.selectedPhoto, { backgroundColor: COLORS.redPale, alignItems: "center", justifyContent: "center" }]}>
                  <Feather name={placeTypeIcon(selectedPlace.types) as any} size={28} color={COLORS.textMid} />
                </View>
              )}
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={s.selectedName} numberOfLines={2}>{selectedPlace.name}</Text>
                <Text style={s.selectedAddr} numberOfLines={2}>{selectedPlace.vicinity ?? selectedPlace.formatted_address}</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 }}>
                  {selectedPlace.rating != null && (
                    <Text style={s.placeRating}>
                      <Feather name="star" size={11} color={COLORS.orange} /> {selectedPlace.rating.toFixed(1)}
                    </Text>
                  )}
                  {selectedPlace.opening_hours?.open_now != null && (
                    <Text style={[s.openStatus, { color: selectedPlace.opening_hours.open_now ? COLORS.green : COLORS.red }]}>
                      {selectedPlace.opening_hours.open_now ? "Open now" : "Closed"}
                    </Text>
                  )}
                  <Text style={s.placeDist}>{formatDist(selectedPlace.distanceM ?? 0)}</Text>
                </View>
              </View>
              <TouchableOpacity onPress={() => { setSelectedPlace(null); setAllergenResults(null); }} style={{ paddingLeft: 8, paddingTop: 2 }}>
                <Feather name="x" size={18} color={COLORS.textLight} />
              </TouchableOpacity>
            </View>

            {/* Dish input */}
            <Text style={s.inputLabel}>Dish to check</Text>
            <TextInput
              style={[s.dishInput, { marginBottom: menuItems.length > 0 ? 8 : 12 }]}
              value={dishInput}
              onChangeText={(t) => { setDishInput(t); setAllergenResults(null); }}
              placeholder={menuItems.length > 0 ? `e.g. ${menuItems[0]}` : "e.g. Burger, Latte…"}
              placeholderTextColor={COLORS.textLight}
              returnKeyType="done"
            />

            {/* Menu item chips — always visible once loaded */}
            {menuItemsLoading && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <ActivityIndicator size="small" color={COLORS.textLight} />
                <Text style={{ fontSize: 12, color: COLORS.textLight }}>Loading menu items…</Text>
              </View>
            )}
            {menuItems.length > 0 && (() => {
              const q = dishInput.toLowerCase().trim();
              const chips = q.length === 0
                ? menuItems.slice(0, 12)
                : menuItems.filter((item) => item.toLowerCase().includes(q)).slice(0, 12);
              if (chips.length === 0) return null;
              return (
                <RNScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ marginBottom: 12 }}
                  contentContainerStyle={{ gap: 8, paddingRight: 4 }}
                  keyboardShouldPersistTaps="always"
                >
                  {chips.map((item) => (
                    <TouchableOpacity
                      key={item}
                      style={[s.menuChip, dishInput === item && s.menuChipActive]}
                      onPress={() => { setDishInput(item); setAllergenResults(null); }}
                      activeOpacity={0.7}
                    >
                      <Text style={[s.menuChipText, dishInput === item && s.menuChipTextActive]} numberOfLines={1}>
                        {item}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </RNScrollView>
              );
            })()}
            <TouchableOpacity style={[s.analyzeBtn, (!dishInput.trim() || analyzing) && { opacity: 0.4 }]}
              onPress={handleAnalyze} disabled={!dishInput.trim() || analyzing}>
              {analyzing
                ? <ActivityIndicator color="#fff" />
                : (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Feather name="search" size={16} color="#fff" />
                    <Text style={s.analyzeBtnText}>Check Allergens</Text>
                  </View>
                )}
            </TouchableOpacity>

            {/* Results */}
            {allergenResults && (
              <View style={{ marginTop: 4 }}>
                {menuInfo && (
                  <View style={[s.sourceBanner, { borderColor: menuInfo.confidence === "high" ? "#6ee7b7" : menuInfo.confidence === "medium" ? "#fde68a" : COLORS.border }]}>
                    <Text style={s.sourceBannerIcon}>{menuInfo.confidence === "high" ? "✓" : menuInfo.confidence === "medium" ? "~" : "?"}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={s.sourceBannerTitle}>{menuInfo.sourceNote}</Text>
                      {menuInfo.menuNotes.slice(0, 2).map((n, i) => <Text key={i} style={s.sourceBannerNote}>• {n}</Text>)}
                    </View>
                  </View>
                )}
                <Text style={[s.sectionLabel, { marginBottom: 8 }]}>Allergen risk for "{dishInput}" at {selectedPlace.name}</Text>
                {sortedAllergens.map((a) => {
                  const d = allergenResults[a.id]; if (!d) return null;
                  const bc = riskBarColor(d.risk);
                  return (
                    <View key={a.id} style={[s.riskCard, { borderColor: bc + "44" }]}>
                      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <Text style={s.riskTitle}>{a.name}</Text>
                        <View style={[s.riskBadge, { backgroundColor: bc + "18", borderColor: bc + "55" }]}>
                          <Text style={[s.riskBadgeText, { color: bc }]}>{d.risk}</Text>
                        </View>
                      </View>
                      <View style={s.progressBg}><View style={[s.progressFill, { width: `${d.score}%`, backgroundColor: bc }]} /></View>
                      <Text style={s.scoreText}>{d.score}% risk</Text>
                      {d.reason.map((r, i) => <Text key={i} style={s.reasonText}>• {r}</Text>)}
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

                <TouchableOpacity style={s.saveBtn} onPress={handleSaveResult}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Feather name="bookmark" size={16} color={COLORS.orange} />
                    <Text style={s.saveBtnText}>Save to Safety Map</Text>
                  </View>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* Back to results */}
        {selectedPlace && searchResults.length > 0 && (
          <TouchableOpacity style={{ paddingHorizontal: 20, paddingVertical: 8 }} onPress={() => { setSelectedPlace(null); setAllergenResults(null); }}>
            <Text style={{ fontSize: 13, color: COLORS.red, fontWeight: "600" }}>← Back to results</Text>
          </TouchableOpacity>
        )}

        {/* Saved list */}
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingTop: 14, paddingBottom: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Feather name="folder" size={13} color={COLORS.textDark} />
            <Text style={s.sectionLabel}>Saved ({saved.length})</Text>
          </View>
          {saved.length > 3 && <TouchableOpacity onPress={() => setShowAllSaved(true)}><Text style={{ fontSize: 13, color: COLORS.red, fontWeight: "600" }}>See all</Text></TouchableOpacity>}
        </View>
        {saved.length === 0 ? (
          <Text style={{ fontSize: 13, color: COLORS.textLight, textAlign: "center", paddingHorizontal: 24, lineHeight: 18 }}>No restaurants saved yet. Search for one, check a dish, then tap "Save to Safety Map".</Text>
        ) : (
          saved.slice(0, 3).map((r) => {
            const ri = riskIcon(r.riskLevel);
            return (
              <TouchableOpacity key={r.id} style={s.placeRow} onPress={() => setSelectedSaved(r)} activeOpacity={0.75}>
                <Feather name={ri.name as any} size={26} color={ri.color} style={{ marginRight: 10 }} />
                <View style={{ flex: 1 }}>
                  <Text style={s.placeName}>{r.name}</Text>
                  {r.notes && <Text style={s.placeAddr} numberOfLines={1}>{r.notes}</Text>}
                </View>
                <View style={[s.riskBadge, { backgroundColor: riskLevelColor(r.riskLevel) + "18", borderColor: riskLevelColor(r.riskLevel) + "55" }]}>
                  <Text style={[s.riskBadgeText, { color: riskLevelColor(r.riskLevel) }]}>{r.riskLevel}</Text>
                </View>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      {/* Saved detail modal */}
      <Modal visible={!!selectedSaved} animationType="slide" presentationStyle="pageSheet">
        {selectedSaved && (() => {
          const ri = riskIcon(selectedSaved.riskLevel);
          return (
            <View style={{ flex: 1, backgroundColor: COLORS.bg }}>
              <View style={s.modalHeader}>
                <Text style={s.modalTitle} numberOfLines={1}>{selectedSaved.name}</Text>
                <Pressable onPress={() => setSelectedSaved(null)}><Text style={{ fontSize: 15, color: COLORS.red, fontWeight: "700" }}>Done</Text></Pressable>
              </View>
              <ScrollView contentContainerStyle={{ padding: 20 }}>
                <View style={{ borderRadius: 16, padding: 20, alignItems: "center", marginBottom: 16, backgroundColor: riskLevelColor(selectedSaved.riskLevel) + "15" }}>
                  <Feather name={ri.name as any} size={44} color={ri.color} style={{ marginBottom: 6 }} />
                  <Text style={{ fontSize: 18, fontWeight: "800", color: riskLevelColor(selectedSaved.riskLevel) }}>{selectedSaved.riskLevel} for your allergens</Text>
                </View>
                {selectedSaved.address && (
                  <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
                    <Feather name="map-pin" size={13} color={COLORS.textMid} style={{ marginRight: 4 }} />
                    <Text style={{ fontSize: 14, color: COLORS.textMid }}>{selectedSaved.address}</Text>
                  </View>
                )}
                {selectedSaved.notes && (
                  <View style={{ backgroundColor: COLORS.white, borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: COLORS.border }}>
                    <Text style={{ fontSize: 10, fontWeight: "700", color: COLORS.textLight, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Notes</Text>
                    <Text style={{ fontSize: 13, color: COLORS.textMid, lineHeight: 18 }}>{selectedSaved.notes}</Text>
                  </View>
                )}
                <Text style={{ fontSize: 12, color: COLORS.textLight, marginBottom: 16 }}>Saved {new Date(selectedSaved.addedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</Text>
                <TouchableOpacity style={s.analyzeBtn} onPress={() => openInMaps(selectedSaved)}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Feather name="map" size={16} color="#fff" />
                    <Text style={s.analyzeBtnText}>Open in Apple Maps</Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity style={{ borderWidth: 1.5, borderColor: "#fca5a5", borderRadius: 14, paddingVertical: 14, alignItems: "center", marginTop: 12 }}
                  onPress={() => Alert.alert("Remove", "Delete this record?", [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => { setSelectedSaved(null); persistSaved(saved.filter((r) => r.id !== selectedSaved.id)); } }])}>
                  <Text style={{ color: COLORS.red, fontSize: 14, fontWeight: "600" }}>Delete Record</Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          );
        })()}
      </Modal>

      {/* All saved modal */}
      <Modal visible={showAllSaved} animationType="slide" presentationStyle="pageSheet">
        <View style={{ flex: 1, backgroundColor: COLORS.bg }}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>Saved Restaurants</Text>
            <Pressable onPress={() => setShowAllSaved(false)}><Text style={{ fontSize: 15, color: COLORS.red, fontWeight: "700" }}>Done</Text></Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            {saved.map((r) => {
              const ri = riskIcon(r.riskLevel);
              return (
                <TouchableOpacity key={r.id} style={s.placeRow} onPress={() => { setShowAllSaved(false); setSelectedSaved(r); }} activeOpacity={0.75}>
                  <Feather name={ri.name as any} size={26} color={ri.color} style={{ marginRight: 10 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.placeName}>{r.name}</Text>
                    {r.notes && <Text style={s.placeAddr} numberOfLines={1}>{r.notes}</Text>}
                  </View>
                  <View style={[s.riskBadge, { backgroundColor: riskLevelColor(r.riskLevel) + "18", borderColor: riskLevelColor(r.riskLevel) + "55" }]}>
                    <Text style={[s.riskBadgeText, { color: riskLevelColor(r.riskLevel) }]}>{r.riskLevel}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  map: { height: 230, width: SCREEN_W },
  mapPlaceholder: { height: 180, backgroundColor: "#e8f4fd", alignItems: "center", justifyContent: "center" },
  locateBtn: { position: "absolute", top: 192, right: 12, width: 40, height: 40, borderRadius: 20, backgroundColor: COLORS.white, alignItems: "center", justifyContent: "center", zIndex: 10, borderWidth: 1, borderColor: COLORS.border, shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },

  searchBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 10, backgroundColor: COLORS.white, borderBottomWidth: 1, borderBottomColor: COLORS.border, gap: 8 },
  searchInput: { flex: 1, borderWidth: 1.5, borderColor: COLORS.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, color: COLORS.textDark, backgroundColor: COLORS.bg },
  sourceBanner: { borderWidth: 1.5, borderRadius: 12, padding: 10, marginBottom: 12, flexDirection: "row", alignItems: "flex-start", gap: 8, backgroundColor: COLORS.white },
  sourceBannerIcon: { fontSize: 16, fontWeight: "800", color: COLORS.textMid, width: 18 },
  sourceBannerTitle: { fontSize: 12, fontWeight: "700", color: COLORS.textDark, marginBottom: 2 },
  sourceBannerNote: { fontSize: 11, color: COLORS.textMid, lineHeight: 15 },
  banner: { backgroundColor: "#eff6ff", paddingVertical: 6, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: "#bfdbfe", flexDirection: "row", alignItems: "center", justifyContent: "center" },
  bannerText: { fontSize: 12, color: "#1d4ed8", fontWeight: "600", textAlign: "center" },

  section: { backgroundColor: COLORS.white, borderRadius: 18, margin: 12, padding: 14, borderWidth: 1, borderColor: COLORS.border, shadowColor: COLORS.red, shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  sectionLabel: { fontSize: 13, fontWeight: "700", color: COLORS.textDark, marginBottom: 10 },

  placeRow: { flexDirection: "row", alignItems: "center", backgroundColor: COLORS.white, borderRadius: 14, padding: 12, marginBottom: 8, marginHorizontal: 12, borderWidth: 1, borderColor: COLORS.border },
  placePhoto: { width: 52, height: 52, borderRadius: 10, marginRight: 12 },
  placePhotoPlaceholder: { width: 52, height: 52, borderRadius: 10, marginRight: 12, backgroundColor: COLORS.redPale, alignItems: "center", justifyContent: "center" },
  placeName: { fontSize: 14, fontWeight: "700", color: COLORS.textDark },
  placeAddr: { fontSize: 12, color: COLORS.textLight, marginTop: 2 },
  placeRating: { fontSize: 12, color: COLORS.textMid, fontWeight: "600" },
  openStatus: { fontSize: 12, fontWeight: "700" },
  placeDist: { fontSize: 12, color: COLORS.textMid, fontWeight: "600", marginLeft: 6 },

  selectedPhoto: { width: 72, height: 72, borderRadius: 12 },
  selectedName: { fontSize: 16, fontWeight: "800", color: COLORS.textDark },
  selectedAddr: { fontSize: 12, color: COLORS.textLight, marginTop: 2 },

  inputLabel: { fontSize: 11, color: COLORS.textMid, fontWeight: "600", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 },
  dishInput: { borderWidth: 1.5, borderColor: COLORS.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, fontSize: 14, color: COLORS.textDark, backgroundColor: COLORS.bg },
  menuChip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20,
    borderWidth: 1.5, borderColor: COLORS.border, backgroundColor: COLORS.white,
  },
  menuChipActive: { backgroundColor: COLORS.red, borderColor: COLORS.red },
  menuChipText: { fontSize: 13, color: COLORS.textMid, fontWeight: "600" },
  menuChipTextActive: { color: "#fff" },
  analyzeBtn: { backgroundColor: COLORS.red, borderRadius: 14, paddingVertical: 13, alignItems: "center", marginBottom: 14, shadowColor: COLORS.red, shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
  analyzeBtnText: { color: "#fff", fontSize: 15, fontWeight: "800" },

  riskCard: { borderWidth: 1.5, borderRadius: 14, padding: 12, marginBottom: 10, backgroundColor: COLORS.white },
  riskTitle: { fontSize: 14, fontWeight: "700", color: COLORS.textDark },
  riskBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderWidth: 1.5 },
  riskBadgeText: { fontSize: 11, fontWeight: "700" },
  progressBg: { height: 6, backgroundColor: COLORS.redPale, borderRadius: 3, marginBottom: 5, overflow: "hidden" },
  progressFill: { height: 6, borderRadius: 3 },
  scoreText: { fontSize: 11, color: COLORS.textMid, marginBottom: 4, fontWeight: "500" },
  reasonText: { fontSize: 11, color: COLORS.textMid, lineHeight: 16 },
  swapsCard: {
    backgroundColor: "#E6F5EF", borderRadius: 14, padding: 12, borderWidth: 1.5,
    borderColor: "#7BC4A0", marginBottom: 10,
  },
  swapsTitle: { fontSize: 13, fontWeight: "700", color: "#1A5C3F" },
  swapRow: { flexDirection: "row", alignItems: "flex-start", marginTop: 6 },
  swapAllergen: { fontSize: 12, fontWeight: "700", color: "#1A5C3F", minWidth: 60 },
  swapAlts: { fontSize: 12, color: "#2D5A40", flex: 1, lineHeight: 17 },

  saveBtn: { borderWidth: 2, borderColor: COLORS.orange, borderRadius: 14, paddingVertical: 12, alignItems: "center", marginTop: 4, backgroundColor: COLORS.white },
  saveBtnText: { color: COLORS.orange, fontSize: 14, fontWeight: "700" },

  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 20, paddingTop: 24, borderBottomWidth: 1.5, borderBottomColor: COLORS.border, backgroundColor: COLORS.white },
  modalTitle: { fontSize: 17, fontWeight: "800", color: COLORS.textDark, flex: 1, marginRight: 16 },
});
