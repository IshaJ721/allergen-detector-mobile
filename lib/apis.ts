// All API calls run directly from the mobile app (no backend server needed)

const MEALDB_BASE = "https://www.themealdb.com/api/json/v1/1";
const USDA_BASE = "https://api.nal.usda.gov/fdc/v1";
const USDA_KEY = "DEMO_KEY"; // swap for a free key at fdc.nal.usda.gov

// Set your Groq API key here or in a config file
export const GROQ_API_KEY = process.env.EXPO_PUBLIC_GROQ_API_KEY ?? "";
const GROQ_BASE = "https://api.groq.com/openai/v1";

export interface VisionResult {
  dish: string;
  visionConfidence: number;
  visibleIngredients: string[];
  uncertaintyNotes: string[];
}

export interface RecipeData {
  ingredients: string[];
  totalRecipes: number;
  ingredientFrequencies: Record<string, number>;
}

export async function identifyDishFromImage(
  base64Image: string,
  mimeType: string,
  dishHint?: string,
  restaurantHint?: string,
  cuisineHint?: string
): Promise<VisionResult> {
  const contextHints = [
    dishHint && `The user thinks the dish might be: ${dishHint}.`,
    restaurantHint && `Restaurant: ${restaurantHint}.`,
    cuisineHint && `Cuisine type: ${cuisineHint}.`,
  ]
    .filter(Boolean)
    .join(" ");

  const prompt = `You are a food analysis expert. Analyze this food image and return ONLY valid JSON (no markdown).

${contextHints}

Return this exact JSON structure:
{
  "dish": "<dish name>",
  "visionConfidence": <0.0-1.0>,
  "visibleIngredients": ["<ingredient1>", "<ingredient2>"],
  "uncertaintyNotes": ["<note1>"]
}`;

  const response = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64Image}` },
            },
          ],
        },
      ],
      max_tokens: 500,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error: ${err}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim() || "";

  try {
    const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned) as VisionResult;
  } catch {
    return {
      dish: dishHint || "Unknown dish",
      visionConfidence: 0.4,
      visibleIngredients: [],
      uncertaintyNotes: ["Could not parse vision model response"],
    };
  }
}

export async function fetchMealDBIngredients(dishName: string): Promise<RecipeData> {
  const url = `${MEALDB_BASE}/search.php?s=${encodeURIComponent(dishName)}`;
  const response = await fetch(url);
  const data = await response.json();

  const meals: Record<string, string>[] = data.meals || [];
  if (meals.length === 0) {
    return { ingredients: [], totalRecipes: 0, ingredientFrequencies: {} };
  }

  const ingredientCounts: Record<string, number> = {};
  const totalRecipes = meals.length;

  for (const meal of meals) {
    const seen = new Set<string>();
    for (let i = 1; i <= 20; i++) {
      const ingredient = meal[`strIngredient${i}`];
      if (ingredient?.trim()) {
        const normalized = ingredient.trim().toLowerCase();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          ingredientCounts[normalized] = (ingredientCounts[normalized] || 0) + 1;
        }
      }
    }
  }

  const ingredientFrequencies: Record<string, number> = {};
  for (const [ing, count] of Object.entries(ingredientCounts)) {
    ingredientFrequencies[ing] = count / totalRecipes;
  }

  return {
    ingredients: Object.keys(ingredientCounts),
    totalRecipes,
    ingredientFrequencies,
  };
}

export async function normalizeWithUSDA(ingredients: string[]): Promise<string[]> {
  if (ingredients.length === 0) return [];
  const normalized: string[] = [];

  for (const ingredient of ingredients.slice(0, 8)) {
    try {
      const url = `${USDA_BASE}/foods/search?query=${encodeURIComponent(ingredient)}&pageSize=1&api_key=${USDA_KEY}`;
      const response = await fetch(url);
      if (!response.ok) { normalized.push(ingredient); continue; }
      const data = await response.json();
      const food = data.foods?.[0];
      normalized.push(food?.description?.toLowerCase() || ingredient);
    } catch {
      normalized.push(ingredient);
    }
  }

  for (const ing of ingredients.slice(8)) normalized.push(ing);
  return [...new Set(normalized)];
}

export async function fetchAllIngredients(dishName: string): Promise<RecipeData> {
  const mealData = await fetchMealDBIngredients(dishName);
  const normalizedIngredients = await normalizeWithUSDA(mealData.ingredients.slice(0, 20));
  return {
    ...mealData,
    ingredients: [...new Set([...mealData.ingredients, ...normalizedIngredients])],
  };
}
