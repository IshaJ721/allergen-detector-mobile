import { GROQ_API_KEY } from "./apis";

const OFF_BASE = "https://world.openfoodfacts.org/api/v2/product";

export interface BarcodeProduct {
  name: string;
  brand: string;
  ingredients: string[];
  ingredientsText: string;
  allergenIds: string[];   // mapped to our allergen id system
  imageUrl?: string;
}

// Map Open Food Facts allergen tags → our allergen IDs
const TAG_MAP: Record<string, string> = {
  "en:milk": "dairy",
  "en:eggs": "egg",
  "en:egg": "egg",
  "en:gluten": "gluten",
  "en:wheat": "gluten",
  "en:peanuts": "peanuts",
  "en:peanut": "peanuts",
  "en:nuts": "tree_nuts",
  "en:tree-nuts": "tree_nuts",
  "en:soybeans": "soy",
  "en:soy": "soy",
  "en:fish": "fish",
  "en:crustaceans": "shellfish",
  "en:shellfish": "shellfish",
  "en:molluscs": "shellfish",
  "en:sesame-seeds": "sesame",
  "en:sesame": "sesame",
  "en:celery": "celery",
  "en:mustard": "mustard",
  "en:sulphur-dioxide-and-sulphites": "sulfites",
};

export async function lookupBarcode(barcode: string): Promise<BarcodeProduct> {
  const url = `${OFF_BASE}/${barcode}.json?fields=product_name,brands,ingredients_text,allergens_tags,allergens_hierarchy,image_front_url`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Network error fetching product");
  const data = await res.json();
  if (data.status !== 1) throw new Error("Product not found in Open Food Facts database");

  const p = data.product;
  const raw = (p.ingredients_text || "").toLowerCase();
  const ingredients = raw
    .split(/[,;\/]/)
    .map((s: string) => s.replace(/\(.*?\)/g, "").trim())
    .filter((s: string) => s.length > 2 && s.length < 50);

  const allergenTags: string[] = p.allergens_tags || p.allergens_hierarchy || [];
  const allergenIds = [...new Set(allergenTags.map((t: string) => TAG_MAP[t]).filter(Boolean))];

  return {
    name: p.product_name || "Unknown Product",
    brand: p.brands || "",
    ingredients,
    ingredientsText: p.ingredients_text || "",
    allergenIds,
    imageUrl: p.image_front_url,
  };
}
