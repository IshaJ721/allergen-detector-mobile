import React, { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { DEFAULT_ALLERGENS } from "../lib/allergens";

const COLORS = {
  red: "#BA3801", orange: "#D45A0A", white: "#ffffff", bg: "#FFFDF5",
  textDark: "#1C2B38", textMid: "#4A6983", textLight: "#8FAEC2",
  border: "#FFE0A0", redPale: "#FFF4E6", green: "#2D7D5A",
};

const RISK_ORDER: Record<string, number> = { High: 0, Likely: 1, Possible: 2, Low: 3 };

function riskColor(risk: string): string {
  switch (risk) {
    case "High":     return "#BA3801";
    case "Likely":   return "#D45A0A";
    case "Possible": return "#B08800";
    default:         return "#2D7D5A";
  }
}

interface HistoryEntry {
  id: string;
  timestamp: number;
  imageUri: string;
  result: {
    dish: string;
    allergens: Record<string, { score: number; risk: string; reason: string[] }>;
  };
}

interface Props {
  history: HistoryEntry[];
}

export default function AnalyticsScreen({ history }: Props) {
  const stats = useMemo(() => {
    if (history.length === 0) return null;

    const allergenRisks: Record<string, Record<string, number>> = {};
    for (const allergen of DEFAULT_ALLERGENS) {
      allergenRisks[allergen.id] = { High: 0, Likely: 0, Possible: 0, Low: 0 };
    }

    const scanRisks = { High: 0, Likely: 0, Possible: 0, Low: 0 };

    const now = Date.now();
    const dayMs = 86400000;
    const dailyCounts: number[] = new Array(7).fill(0);

    for (const entry of history) {
      let worstRisk = "Low";
      for (const [id, res] of Object.entries(entry.result.allergens)) {
        if (allergenRisks[id]) {
          allergenRisks[id][res.risk] = (allergenRisks[id][res.risk] || 0) + 1;
        }
        if ((RISK_ORDER[res.risk] ?? 3) < (RISK_ORDER[worstRisk] ?? 3)) {
          worstRisk = res.risk;
        }
      }
      scanRisks[worstRisk as keyof typeof scanRisks]++;

      const daysAgo = Math.floor((now - entry.timestamp) / dayMs);
      if (daysAgo < 7) dailyCounts[daysAgo]++;
    }

    const allergenScores = DEFAULT_ALLERGENS.map((a) => ({
      id: a.id,
      name: a.name,
      serious: (allergenRisks[a.id]?.High || 0) + (allergenRisks[a.id]?.Likely || 0),
      total: Object.values(allergenRisks[a.id] || {}).reduce((s, v) => s + v, 0),
    })).sort((a, b) => b.serious - a.serious);

    const maxSerious = Math.max(...allergenScores.map((a) => a.serious), 1);

    return { allergenScores, scanRisks, dailyCounts, maxSerious };
  }, [history]);

  const maxDaily = stats ? Math.max(...stats.dailyCounts, 1) : 1;
  const dayLabels = ["Today", "1d", "2d", "3d", "4d", "5d", "6d"];

  if (history.length === 0) {
    return (
      <View style={s.empty}>
        <Feather name="bar-chart-2" size={64} color={COLORS.red} style={{ marginBottom: 16 }} />
        <Text style={s.emptyTitle}>No Data Yet</Text>
        <Text style={s.emptySub}>Scan some food to see your allergen exposure analytics.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={s.scroll} contentContainerStyle={s.content}>
      <View style={s.row}>
        <View style={[s.statCard, { flex: 1, marginRight: 8 }]}>
          <Text style={s.statNum}>{history.length}</Text>
          <Text style={s.statLabel}>Total Scans</Text>
        </View>
        <View style={[s.statCard, { flex: 1, marginLeft: 8 }]}>
          <Text style={[s.statNum, { color: COLORS.red }]}>{stats?.scanRisks.High ?? 0}</Text>
          <Text style={s.statLabel}>High Risk Scans</Text>
        </View>
      </View>
      <View style={s.row}>
        <View style={[s.statCard, { flex: 1, marginRight: 8 }]}>
          <Text style={[s.statNum, { color: COLORS.orange }]}>{stats?.scanRisks.Likely ?? 0}</Text>
          <Text style={s.statLabel}>Likely Risk</Text>
        </View>
        <View style={[s.statCard, { flex: 1, marginLeft: 8 }]}>
          <Text style={[s.statNum, { color: COLORS.green }]}>{stats?.scanRisks.Low ?? 0}</Text>
          <Text style={s.statLabel}>Safe Scans</Text>
        </View>
      </View>

      <View style={s.section}>
        <View style={s.sectionTitleRow}>
          <Feather name="trending-up" size={14} color={COLORS.textDark} style={{ marginRight: 6 }} />
          <Text style={s.sectionTitle}>Scan Risk Breakdown</Text>
        </View>
        {(["High", "Likely", "Possible", "Low"] as const).map((risk) => {
          const count = stats?.scanRisks[risk] ?? 0;
          const pct = history.length > 0 ? count / history.length : 0;
          return (
            <View key={risk} style={s.barRow}>
              <Text style={[s.barLabel, { color: riskColor(risk) }]}>{risk}</Text>
              <View style={s.barTrack}>
                <View style={[s.barFill, { width: `${pct * 100}%`, backgroundColor: riskColor(risk) }]} />
              </View>
              <Text style={s.barCount}>{count}</Text>
            </View>
          );
        })}
      </View>

      <View style={s.section}>
        <View style={s.sectionTitleRow}>
          <Feather name="calendar" size={14} color={COLORS.textDark} style={{ marginRight: 6 }} />
          <Text style={s.sectionTitle}>Scans Last 7 Days</Text>
        </View>
        <View style={s.chartRow}>
          {stats?.dailyCounts.map((count, i) => (
            <View key={i} style={s.dayCol}>
              <View style={s.dayBarContainer}>
                <View style={[s.dayBar, {
                  height: maxDaily > 0 ? Math.max((count / maxDaily) * 80, count > 0 ? 6 : 0) : 0,
                  backgroundColor: count > 0 ? COLORS.red : COLORS.border,
                }]} />
              </View>
              <Text style={s.dayCount}>{count}</Text>
              <Text style={s.dayLabel}>{dayLabels[i]}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={s.section}>
        <View style={s.sectionTitleRow}>
          <Feather name="alert-triangle" size={14} color={COLORS.textDark} style={{ marginRight: 6 }} />
          <Text style={s.sectionTitle}>Allergen Exposure (High + Likely)</Text>
        </View>
        {stats?.allergenScores.filter((a) => a.total > 0).slice(0, 7).map((a) => (
          <View key={a.id} style={s.barRow}>
            <Text style={s.barLabel} numberOfLines={1}>{a.name}</Text>
            <View style={s.barTrack}>
              <View style={[s.barFill, {
                width: `${(a.serious / (stats?.maxSerious ?? 1)) * 100}%`,
                backgroundColor: a.serious > 0 ? COLORS.red : COLORS.border,
              }]} />
            </View>
            <Text style={s.barCount}>{a.serious}</Text>
          </View>
        ))}
        {stats?.allergenScores.every((a) => a.total === 0) && (
          <Text style={s.noData}>No allergen encounters recorded yet.</Text>
        )}
      </View>

      <View style={s.section}>
        <View style={s.sectionTitleRow}>
          <Feather name="clock" size={14} color={COLORS.textDark} style={{ marginRight: 6 }} />
          <Text style={s.sectionTitle}>Recent Scans</Text>
        </View>
        {history.slice(0, 5).map((entry) => {
          const allergenEntries = Object.entries(entry.result.allergens);
          const worstRisk = allergenEntries.reduce((best, [, v]) => {
            return (RISK_ORDER[v.risk] ?? 3) < (RISK_ORDER[best] ?? 3) ? v.risk : best;
          }, "Low");
          return (
            <View key={entry.id} style={s.recentRow}>
              <View style={[s.riskDot, { backgroundColor: riskColor(worstRisk) }]} />
              <Text style={s.recentDish} numberOfLines={1}>{entry.result.dish}</Text>
              <Text style={[s.recentRisk, { color: riskColor(worstRisk) }]}>{worstRisk}</Text>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: 20, paddingTop: 16, paddingBottom: 48 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, backgroundColor: COLORS.bg },
  emptyTitle: { fontSize: 22, fontWeight: "800", color: COLORS.textDark, marginBottom: 8 },
  emptySub: { fontSize: 14, color: COLORS.textMid, textAlign: "center", lineHeight: 20 },

  row: { flexDirection: "row", marginBottom: 12 },
  statCard: {
    backgroundColor: COLORS.white, borderRadius: 18, padding: 16, alignItems: "center",
    borderWidth: 1, borderColor: COLORS.border,
    shadowColor: COLORS.red, shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
  },
  statNum: { fontSize: 32, fontWeight: "900", color: COLORS.textDark },
  statLabel: { fontSize: 11, color: COLORS.textLight, fontWeight: "600", marginTop: 2, textTransform: "uppercase", letterSpacing: 0.5 },

  section: {
    backgroundColor: COLORS.white, borderRadius: 20, padding: 16, marginBottom: 16,
    borderWidth: 1, borderColor: COLORS.border,
    shadowColor: COLORS.red, shadowOpacity: 0.07, shadowRadius: 10, shadowOffset: { width: 0, height: 2 },
  },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", marginBottom: 14 },
  sectionTitle: { fontSize: 14, fontWeight: "700", color: COLORS.textDark },

  barRow: { flexDirection: "row", alignItems: "center", marginBottom: 10 },
  barLabel: { width: 72, fontSize: 12, fontWeight: "600", color: COLORS.textMid },
  barTrack: { flex: 1, height: 10, backgroundColor: "#f3f4f6", borderRadius: 5, overflow: "hidden", marginHorizontal: 10 },
  barFill: { height: 10, borderRadius: 5 },
  barCount: { width: 24, fontSize: 12, fontWeight: "700", color: COLORS.textDark, textAlign: "right" },

  chartRow: { flexDirection: "row", justifyContent: "space-around", alignItems: "flex-end" },
  dayCol: { alignItems: "center", flex: 1 },
  dayBarContainer: { height: 88, justifyContent: "flex-end", alignItems: "center" },
  dayBar: { width: 24, borderRadius: 6 },
  dayCount: { fontSize: 12, fontWeight: "700", color: COLORS.textDark, marginTop: 4 },
  dayLabel: { fontSize: 10, color: COLORS.textLight, fontWeight: "600", marginTop: 2 },

  recentRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#f3f4f6" },
  riskDot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  recentDish: { flex: 1, fontSize: 13, fontWeight: "600", color: COLORS.textDark },
  recentRisk: { fontSize: 12, fontWeight: "700" },
  noData: { fontSize: 13, color: COLORS.textLight, textAlign: "center", paddingVertical: 8 },
});
