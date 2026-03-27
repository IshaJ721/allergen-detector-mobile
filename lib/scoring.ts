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
  recipeIngredients: string[];
  ingredientFrequency: number; // 0–1
  dishName: string;
}

function normalizeText(text: string): string {
  return text.toLowerCase().trim();
}

function keywordMatch(keywords: string[], ingredients: string[]): boolean {
  const normalizedIngredients = ingredients.map(normalizeText);
  return keywords.some((kw) =>
    normalizedIngredients.some(
      (ing) => ing.includes(normalizeText(kw)) || normalizeText(kw).includes(ing)
    )
  );
}

export function scoreAllergen(input: ScoringInput): AllergenScore {
  const { allergen, visionConfidence, visibleIngredients, recipeIngredients, ingredientFrequency, dishName } = input;

  const visibleMatch = keywordMatch(allergen.keywords, visibleIngredients);
  const recipeMatch = keywordMatch(allergen.keywords, recipeIngredients);

  const visibleSignal = visibleMatch ? 1 : 0;

  // Weighted score: 50% vision confidence (if visible match), 35% recipe frequency, 15% visible signal
  const visionComponent = visibleMatch ? 0.5 * visionConfidence : 0;
  const recipeComponent = 0.35 * ingredientFrequency;
  const visibleComponent = 0.15 * visibleSignal;

  // If recipe match but not visible, still add partial recipe score
  const recipeOnlyBoost = recipeMatch && !visibleMatch ? 0.35 * ingredientFrequency : 0;

  const rawScore = (visionComponent + recipeComponent + visibleComponent + recipeOnlyBoost) * 100;
  const score = Math.round(Math.min(100, Math.max(0, rawScore)));

  const risk = getRiskLabel(score);
  const reason = buildReasons(input, visibleMatch, recipeMatch, score);

  return { score, risk, reason };
}

function getRiskLabel(score: number): "Low" | "Possible" | "Likely" | "High" {
  if (score <= 25) return "Low";
  if (score <= 55) return "Possible";
  if (score <= 80) return "Likely";
  return "High";
}

function buildReasons(
  input: ScoringInput,
  visibleMatch: boolean,
  recipeMatch: boolean,
  score: number
): string[] {
  const reasons: string[] = [];
  const { allergen, dishName, visionConfidence, ingredientFrequency } = input;

  if (dishName) {
    reasons.push(`Dish identified as "${dishName}"`);
  }

  if (visibleMatch) {
    reasons.push(`${allergen.name} ingredient(s) detected in the image`);
  }

  if (recipeMatch && ingredientFrequency > 0) {
    const pct = Math.round(ingredientFrequency * 100);
    reasons.push(`${allergen.name} found in ~${pct}% of similar recipes`);
  }

  if (visionConfidence < 0.6 && visionConfidence > 0) {
    reasons.push(`Image recognition confidence is low (${Math.round(visionConfidence * 100)}%) — dish may be misidentified`);
  }

  if (!visibleMatch && !recipeMatch) {
    reasons.push(`No ${allergen.name} ingredients detected in image or recipes`);
  }

  if (score > 50) {
    reasons.push("Hidden or sauce ingredients may contain traces");
  }

  return reasons;
}
