export interface Allergen {
  id: string;
  name: string;
  keywords: string[];
  custom?: boolean;
}

export const DEFAULT_ALLERGENS: Allergen[] = [
  {
    id: "peanuts",
    name: "Peanuts",
    keywords: ["peanut", "peanuts", "groundnut", "groundnuts", "arachis"],
  },
  {
    id: "tree_nuts",
    name: "Tree Nuts",
    keywords: [
      "almond", "almonds", "walnut", "walnuts", "cashew", "cashews",
      "pistachio", "pistachios", "pecan", "pecans", "hazelnut", "hazelnuts",
      "macadamia", "brazil nut", "pine nut", "pine nuts", "chestnut",
    ],
  },
  {
    id: "dairy",
    name: "Dairy",
    keywords: [
      "milk", "cheese", "butter", "cream", "yogurt", "whey", "casein",
      "lactose", "ghee", "sour cream", "buttermilk", "cheddar", "mozzarella",
      "parmesan", "ricotta", "brie", "gouda",
    ],
  },
  {
    id: "egg",
    name: "Egg",
    keywords: [
      "egg", "eggs", "yolk", "egg white", "albumin", "mayonnaise",
      "meringue", "lecithin",
    ],
  },
  {
    id: "soy",
    name: "Soy",
    keywords: [
      "soy", "soya", "soybean", "soybeans", "tofu", "tempeh", "miso",
      "edamame", "soy sauce", "tamari", "soy milk",
    ],
  },
  {
    id: "gluten",
    name: "Gluten / Wheat",
    keywords: [
      "wheat", "gluten", "flour", "bread", "pasta", "noodles", "barley",
      "rye", "semolina", "spelt", "farro", "couscous", "seitan", "bulgur",
      "breadcrumbs", "panko",
    ],
  },
  {
    id: "shellfish",
    name: "Shellfish",
    keywords: [
      "shrimp", "prawn", "crab", "lobster", "crayfish", "clam", "oyster",
      "scallop", "mussel", "squid", "octopus", "abalone", "shellfish",
    ],
  },
  {
    id: "fish",
    name: "Fish",
    keywords: [
      "fish", "salmon", "tuna", "cod", "tilapia", "bass", "flounder",
      "anchovies", "anchovy", "sardine", "mackerel", "halibut", "trout",
      "fish sauce", "worcestershire",
    ],
  },
  {
    id: "sesame",
    name: "Sesame",
    keywords: [
      "sesame", "tahini", "sesame oil", "sesame seeds", "til", "gingelly",
    ],
  },
];
