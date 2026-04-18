// All API calls run directly from the mobile app (no backend server needed)

const MEALDB_BASE = "https://www.themealdb.com/api/json/v1/1";

export const GROQ_API_KEY = process.env.EXPO_PUBLIC_GROQ_API_KEY ?? "";
const GROQ_BASE = "https://api.groq.com/openai/v1";

export interface VisionResult {
  dish: string;
  visionConfidence: number;
  visibleIngredients: string[];
  hiddenIngredients: string[];   // inferred — sauces, batters, dressings etc.
  allergenFlags: Record<string, boolean>; // direct LLM allergen knowledge
  uncertaintyNotes: string[];
}

export interface RecipeData {
  ingredients: string[];
  totalRecipes: number;
  ingredientFrequencies: Record<string, number>;
}

// ─── Vision + allergen identification ────────────────────────────────────────

export async function identifyDishFromImage(
  base64Image: string,
  mimeType: string,
  dishHint?: string,
  restaurantHint?: string,
  cuisineHint?: string
): Promise<VisionResult> {
  const contextHints = [
    dishHint && `The user says the dish is: ${dishHint}.`,
    restaurantHint && `Restaurant: ${restaurantHint}.`,
    cuisineHint && `Cuisine type: ${cuisineHint}.`,
  ]
    .filter(Boolean)
    .join(" ");

  const prompt = `You are an expert food analyst and allergen specialist. Analyze this food image carefully.
${contextHints}

Return ONLY valid JSON (no markdown, no explanation):
{
  "dish": "<specific dish name>",
  "visionConfidence": <0.0-1.0 how confident you are in the dish identification>,
  "visibleIngredients": ["ingredients you can directly see in the image"],
  "hiddenIngredients": ["typical hidden ingredients in this dish: sauces, batters, dressings, marinades, cooking oils, thickeners — even if not visible"],
  "allergenFlags": {
    "peanuts": <true if peanuts/groundnuts are commonly or certainly in this dish>,
    "tree_nuts": <true if almonds/cashews/walnuts etc. are commonly in this dish>,
    "dairy": <true if milk/cheese/butter/cream are in this dish>,
    "egg": <true if eggs are in this dish>,
    "soy": <true if soy/tofu/soy sauce are in this dish>,
    "gluten": <true if wheat/flour/bread/pasta/soy sauce/beer batter are in this dish>,
    "shellfish": <true if shrimp/crab/lobster/scallop etc. are in this dish>,
    "fish": <true if fish/fish sauce/worcestershire/anchovies are in this dish>,
    "sesame": <true if sesame oil/tahini/sesame seeds are in this dish>
  },
  "uncertaintyNotes": ["any notes about uncertainty, unclear ingredients, or risk of cross-contamination"]
}

Be thorough and conservative — if an allergen is commonly used in this type of dish even if not visible, flag it true.`;

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
      max_tokens: 800,
      temperature: 0.1,
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
    const parsed = JSON.parse(cleaned);
    return {
      dish: parsed.dish || dishHint || "Unknown dish",
      visionConfidence: parsed.visionConfidence ?? 0.5,
      visibleIngredients: parsed.visibleIngredients || [],
      hiddenIngredients: parsed.hiddenIngredients || [],
      allergenFlags: parsed.allergenFlags || {},
      uncertaintyNotes: parsed.uncertaintyNotes || [],
    };
  } catch {
    return {
      dish: dishHint || "Unknown dish",
      visionConfidence: 0.4,
      visibleIngredients: [],
      hiddenIngredients: [],
      allergenFlags: {},
      uncertaintyNotes: ["Could not parse vision model response"],
    };
  }
}

// ─── MealDB recipe lookup ─────────────────────────────────────────────────────

export async function fetchMealDBIngredients(dishName: string): Promise<RecipeData> {
  // Try exact search first, then try first word (e.g. "Pad Thai" → "Pad")
  const queries = [dishName, dishName.split(" ")[0]].filter(Boolean);

  for (const query of queries) {
    try {
      const url = `${MEALDB_BASE}/search.php?s=${encodeURIComponent(query)}`;
      const response = await fetch(url);
      const data = await response.json();
      const meals: Record<string, string>[] = data.meals || [];
      if (meals.length === 0) continue;

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

      return { ingredients: Object.keys(ingredientCounts), totalRecipes, ingredientFrequencies };
    } catch {
      continue;
    }
  }

  return { ingredients: [], totalRecipes: 0, ingredientFrequencies: {} };
}

// ─── LLM ingredient fallback (when MealDB has nothing) ────────────────────────

export async function fetchIngredientsFromLLM(dishName: string): Promise<string[]> {
  if (!GROQ_API_KEY) return [];
  try {
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
            content: `List all typical ingredients in "${dishName}", including hidden ones like sauces, batters, marinades, dressings, and condiments. Be thorough. Return ONLY a JSON array of lowercase ingredient strings, no explanation.`,
          },
        ],
        max_tokens: 400,
        temperature: 0.1,
      }),
    });
    if (!response.ok) return [];
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim() || "[]";
    const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed.map((s: string) => String(s).toLowerCase()) : [];
  } catch {
    return [];
  }
}

// ─── Menu photo analysis ─────────────────────────────────────────────────────

export async function analyzeMenuForDishes(
  base64Image: string,
  mimeType: string,
  restaurantName?: string
): Promise<string[]> {
  const context = restaurantName ? `This is a menu from "${restaurantName}". ` : "";
  const prompt = `${context}Extract all dish and menu item names visible in this menu image. Return ONLY a JSON array of strings, no explanation. Example: ["Pad Thai", "Green Curry", "Spring Rolls"]`;

  const response = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } },
          ],
        },
      ],
      max_tokens: 600,
      temperature: 0.1,
    }),
  });
  if (!response.ok) throw new Error(`Groq API error: ${await response.text()}`);
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim() || "[]";
  try {
    const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function analyzeDishFromName(
  dishName: string,
  restaurantName?: string
): Promise<VisionResult> {
  if (!GROQ_API_KEY) throw new Error("API key missing");
  const context = restaurantName
    ? `The dish "${dishName}" is from the restaurant "${restaurantName}". Use your knowledge of this specific restaurant's recipes and ingredients.`
    : `The dish is "${dishName}".`;

  const prompt = `You are an expert food allergen specialist. ${context}

Return ONLY valid JSON:
{
  "dish": "${dishName}",
  "visionConfidence": 0.85,
  "visibleIngredients": ["main ingredients you know are in this dish"],
  "hiddenIngredients": ["hidden ingredients like sauces, batters, dressings, oils, thickeners"],
  "allergenFlags": {
    "peanuts": <true/false>,
    "tree_nuts": <true/false>,
    "dairy": <true/false>,
    "egg": <true/false>,
    "soy": <true/false>,
    "gluten": <true/false>,
    "shellfish": <true/false>,
    "fish": <true/false>,
    "sesame": <true/false>
  },
  "uncertaintyNotes": []
}`;

  const response = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
      temperature: 0.1,
    }),
  });
  if (!response.ok) throw new Error(`Groq API error: ${await response.text()}`);
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim() || "";
  try {
    const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      dish: parsed.dish || dishName,
      visionConfidence: parsed.visionConfidence ?? 0.85,
      visibleIngredients: parsed.visibleIngredients || [],
      hiddenIngredients: parsed.hiddenIngredients || [],
      allergenFlags: parsed.allergenFlags || {},
      uncertaintyNotes: parsed.uncertaintyNotes || [],
    };
  } catch {
    return { dish: dishName, visionConfidence: 0.7, visibleIngredients: [], hiddenIngredients: [], allergenFlags: {}, uncertaintyNotes: [] };
  }
}

// ─── Main ingredient aggregator ───────────────────────────────────────────────

export async function fetchAllIngredients(
  dishName: string,
  visionIngredients: string[] = []
): Promise<RecipeData> {
  const mealData = await fetchMealDBIngredients(dishName);

  // If MealDB found nothing, fall back to LLM-generated ingredient list
  let extraIngredients: string[] = [];
  if (mealData.totalRecipes === 0) {
    extraIngredients = await fetchIngredientsFromLLM(dishName);
  }

  const allIngredients = [
    ...new Set([
      ...mealData.ingredients,
      ...extraIngredients,
      ...visionIngredients.map((i) => i.toLowerCase()),
    ]),
  ];

  // Build frequencies: LLM fallback ingredients get frequency 0.8 (likely)
  const frequencies = { ...mealData.ingredientFrequencies };
  for (const ing of extraIngredients) {
    if (!frequencies[ing]) frequencies[ing] = 0.8;
  }
  // Vision-confirmed ingredients get frequency 1.0
  for (const ing of visionIngredients) {
    const key = ing.toLowerCase();
    frequencies[key] = 1.0;
  }

  return {
    ingredients: allIngredients,
    totalRecipes: mealData.totalRecipes,
    ingredientFrequencies: frequencies,
  };
}

// ─── Restaurant menu items ────────────────────────────────────────────────────

export async function fetchRestaurantMenuItems(restaurantName: string): Promise<string[]> {
  if (!GROQ_API_KEY) return [];
  const prompt = `You are a restaurant menu database. List the ACTUAL current menu items sold at "${restaurantName}".

Use your training data knowledge of their real menu. For example:
- McDonald's: Big Mac, McDouble, Quarter Pounder, Filet-O-Fish, McNuggets (4/6/10/20pc), McFlurry, McRib, Egg McMuffin, Hash Browns, French Fries, Apple Pie, Shamrock Shake, etc.
- Chipotle: Burrito, Burrito Bowl, Tacos, Quesadilla, Salad, Chips & Guacamole, Sofritas, Carnitas, etc.
- Starbucks: Caramel Macchiato, Pumpkin Spice Latte, Frappuccino, Cold Brew, Flat White, etc.

Return ONLY a JSON array of the actual item names — no markdown, no explanation, no categories:
["Exact Item Name 1", "Exact Item Name 2", ...]

Return 25–35 real menu items. Do NOT make up items. If you are uncertain about a specific item name, use the most common/known version.`;

  try {
    const response = await fetch(`${GROQ_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 400,
        temperature: 0.1,
      }),
    });
    if (!response.ok) return [];
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "";
    // Extract JSON array from anywhere in the response (model may add text around it)
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter((x: any) => typeof x === "string" && x.trim().length > 0) : [];
  } catch { return []; }
}

// ─── Restaurant menu / allergen research ──────────────────────────────────────

export interface RestaurantMenuInfo {
  sourceNote: string;           // e.g. "Based on McDonald's published allergen menu"
  confirmedAllergens: string[]; // allergen IDs confirmed present
  confirmedSafe: string[];      // allergen IDs confirmed absent
  dishIngredients: string[];    // ingredients specific to this dish at this restaurant
  confidence: "high" | "medium" | "low";
  menuNotes: string[];          // e.g. "Contains sesame bun", "Cooked in shared fryer"
}

export async function fetchRestaurantMenuInfo(
  dishName: string,
  restaurantName: string
): Promise<RestaurantMenuInfo> {
  if (!GROQ_API_KEY) throw new Error("API key missing");

  const prompt = `You are a food allergen database with knowledge of restaurant allergen guides, FDA nutrition filings, and published ingredient lists.

Item: "${dishName}" at "${restaurantName}"

Pull from your training data: the restaurant's allergen PDF/webpage, nutrition calculator, or ingredient disclosures.

Rules:
- "confidence": "high" if you have specific data for this exact restaurant chain (e.g. McDonald's, Chipotle, Starbucks, Subway)
- "confidence": "medium" if you have partial data or this is a well-known cuisine type
- "confidence": "low" only if this is a truly obscure local restaurant with no known data
- "sourceNote": be specific — name the actual source, e.g. "McDonald's US allergen guide (mcdonalds.com)", NOT "general culinary knowledge"
- For chains, use their actual published allergen matrix data

Return ONLY valid JSON — no markdown:
{
  "sourceNote": "e.g. 'McDonald's US allergen guide' or 'Chipotle ingredient statement' or 'Standard Italian cuisine composition'",
  "confidence": "high" | "medium" | "low",
  "dishIngredients": ["actual ingredients used in this specific item at this restaurant"],
  "confirmedAllergens": ["allergen IDs confirmed present — only from: peanuts, tree_nuts, dairy, egg, soy, gluten, shellfish, fish, sesame"],
  "confirmedSafe": ["allergen IDs confirmed absent per published data"],
  "menuNotes": ["specific facts like 'bun contains sesame seeds', 'shared fryer with fish items', 'sauce contains soy']"
}`;

  try {
    const response = await fetch(`${GROQ_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 600,
        temperature: 0.1,
      }),
    });
    if (!response.ok) throw new Error("Groq error");
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim() ?? "";
    const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      sourceNote: parsed.sourceNote ?? `Based on general knowledge of ${restaurantName}`,
      confidence: parsed.confidence ?? "low",
      dishIngredients: parsed.dishIngredients ?? [],
      confirmedAllergens: parsed.confirmedAllergens ?? [],
      confirmedSafe: parsed.confirmedSafe ?? [],
      menuNotes: parsed.menuNotes ?? [],
    };
  } catch {
    return { sourceNote: "General culinary knowledge", confidence: "low", dishIngredients: [], confirmedAllergens: [], confirmedSafe: [], menuNotes: [] };
  }
}

// ─── Barcode reading from image ───────────────────────────────────────────────

export async function readBarcodeFromImage(base64Image: string): Promise<string> {
  if (!GROQ_API_KEY) throw new Error("No API key");
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${base64Image}` },
          },
          {
            type: "text",
            text: "Look at this image and find the barcode (EAN-13, UPC-A, EAN-8, or similar). Return ONLY the numeric barcode digits with no other text, spaces, or explanation. If you cannot find a barcode, return the word NONE.",
          },
        ],
      }],
      max_tokens: 50,
      temperature: 0,
    }),
  });
  const data = await res.json();
  const raw: string = data.choices?.[0]?.message?.content?.trim() ?? "NONE";
  const digits = raw.replace(/\D/g, "");
  if (!digits || digits.length < 6) throw new Error("No barcode found in image");
  return digits;
}

// ─── Safe alternatives suggester ─────────────────────────────────────────────

export interface AllergenSwap {
  allergen: string;
  alternatives: string[];
}

export async function fetchSafeAlternatives(
  dishName: string,
  riskyAllergens: string[],
  ingredients: string[]
): Promise<AllergenSwap[]> {
  if (!GROQ_API_KEY || riskyAllergens.length === 0) return [];
  const ingredientHint = ingredients.length > 0
    ? `Known ingredients include: ${ingredients.slice(0, 20).join(", ")}.`
    : "";
  const prompt = `The dish "${dishName}" contains these allergens at HIGH or LIKELY risk: ${riskyAllergens.join(", ")}. ${ingredientHint}

For each allergen, suggest 2–3 specific ingredient swaps that preserve the dish's flavor/texture and are safe for someone with that allergy. Be concrete — name real ingredients, not categories.

Return ONLY a JSON array, no other text:
[{"allergen": "Peanuts", "alternatives": ["sunflower seed butter", "pumpkin seeds", "toasted chickpeas"]}, ...]`;

  try {
    const res = await fetch(`${GROQ_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 350,
        temperature: 0.3,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content ?? "";
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed)
      ? parsed.filter((x: any) => typeof x.allergen === "string" && Array.isArray(x.alternatives))
      : [];
  } catch { return []; }
}
