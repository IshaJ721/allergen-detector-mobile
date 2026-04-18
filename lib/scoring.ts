import { Allergen } from "./allergens";

export interface AllergenScore {
  score: number;
  risk: "Low" | "Possible" | "Likely" | "High";
  reason: string[];
}

export interface ScoringInput {
  allergen: Allergen;
  visionConfidence: number;
  visibleIngredients: string[];
  hiddenIngredients: string[];
  recipeIngredients: string[];
  ingredientFrequency: number; // 0–1
  dishName: string;
  allergenFlag?: boolean;          // LLM general assessment
  restaurantConfirmedPresent?: boolean; // restaurant's own allergen menu says YES
  restaurantConfirmedSafe?: boolean;    // restaurant's own allergen menu says NO
  restaurantConfidence?: "high" | "medium" | "low";
}

function normalizeText(t: string) { return t.toLowerCase().trim(); }

function keywordMatch(keywords: string[], ingredients: string[]): boolean {
  const normed = ingredients.map(normalizeText);
  return keywords.some((kw) => normed.some((ing) => ing.includes(normalizeText(kw)) || normalizeText(kw).includes(ing)));
}

export function scoreAllergen(input: ScoringInput): AllergenScore {
  const {
    allergen, visionConfidence,
    visibleIngredients, hiddenIngredients, recipeIngredients,
    ingredientFrequency, allergenFlag,
    restaurantConfirmedPresent, restaurantConfirmedSafe, restaurantConfidence,
  } = input;

  const visibleMatch = keywordMatch(allergen.keywords, visibleIngredients);
  const hiddenMatch  = keywordMatch(allergen.keywords, hiddenIngredients);
  const recipeMatch  = keywordMatch(allergen.keywords, recipeIngredients);

  // ── Tier 1: Restaurant's own published allergen data ─────────────────────────
  // This is the ground truth — treat it like an official label.
  if (restaurantConfirmedSafe === true) {
    // Restaurant explicitly states this item does NOT contain the allergen.
    // Keep a tiny residual (2%) to represent cross-contamination possibility.
    const residual = restaurantConfidence === "high" ? 2 : 5;
    return {
      score: residual,
      risk: "Low",
      reason: [
        `Confirmed allergen-free on ${allergen.name} per the restaurant's published allergen menu`,
        ...(residual > 2 ? ["Small residual reflects possible cross-contamination in shared kitchen"] : []),
      ],
    };
  }

  if (restaurantConfirmedPresent === true) {
    // Restaurant explicitly lists this allergen.
    const base = restaurantConfidence === "high" ? 95 : 85;
    return {
      score: base,
      risk: "High",
      reason: [
        `${allergen.name} confirmed present per the restaurant's official allergen menu`,
        "Avoid if you have a ${allergen.name} allergy",
      ],
    };
  }

  // ── Tier 2: Ingredient signals (vision + recipe + LLM) ───────────────────────
  // Start from 0 — only add points for positive evidence.

  let score = 0;
  const reasons: string[] = [];

  // LLM direct flag (strong signal, but not ground truth)
  if (allergenFlag === true) {
    score += 40;
    reasons.push(`AI identifies ${allergen.name} as typically present in this dish`);
  } else if (allergenFlag === false) {
    // Explicit LLM negative — reduces baseline, but doesn't override ingredient matches
    score -= 5;
    reasons.push(`AI assessment: ${allergen.name} not typically in this dish`);
  }

  // Visible ingredient match
  if (visibleMatch) {
    score += Math.round(visionConfidence * 28);
    reasons.push(`${allergen.name} ingredient detected in the dish`);
  }

  // Hidden ingredient match (sauces, batters, etc.)
  if (hiddenMatch) {
    score += 12;
    reasons.push(`${allergen.name} likely present in sauce, batter, or marinade`);
  }

  // Recipe frequency — only contributes if there's a match
  if (recipeMatch && ingredientFrequency > 0) {
    score += Math.round(ingredientFrequency * 22);
    reasons.push(`Found in ~${Math.round(ingredientFrequency * 100)}% of similar recipes`);
  }

  // No evidence at all → near-zero
  if (!visibleMatch && !hiddenMatch && !recipeMatch && allergenFlag !== true) {
    reasons.push(`No ${allergen.name} ingredients detected`);
  }

  // Cross-contamination note for high-risk results
  const finalScore = Math.round(Math.min(98, Math.max(0, score)));
  if (finalScore > 55) {
    reasons.push("Cross-contamination risk possible if prepared in shared kitchen");
  }

  if (visionConfidence < 0.6 && visionConfidence > 0) {
    reasons.push(`Lower confidence — dish may be misidentified`);
  }

  return { score: finalScore, risk: getRiskLabel(finalScore), reason: reasons };
}

function getRiskLabel(score: number): "Low" | "Possible" | "Likely" | "High" {
  if (score <= 15) return "Low";
  if (score <= 45) return "Possible";
  if (score <= 70) return "Likely";
  return "High";
}
