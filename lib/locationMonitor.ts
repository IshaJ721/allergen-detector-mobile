import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";

const TASK_NAME = "FOOD_PLACE_MONITOR";
const GOOGLE_KEY = process.env.EXPO_PUBLIC_GOOGLE_PLACES_KEY ?? "";

const DISTANCE_INTERVAL = 100;
const SEARCH_RADIUS = 10;
const COOLDOWN_MS = 20 * 60 * 1000;

const lastNotified: Record<string, number> = {};

// Works for both foreground and background delivery
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

async function checkForFoodPlace(lat: number, lon: number) {
  if (!GOOGLE_KEY) return;
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_KEY,
        "X-Goog-FieldMask": "places.id,places.displayName,places.types",
      },
      body: JSON.stringify({
        includedTypes: ["restaurant", "cafe", "bakery", "fast_food_restaurant", "food_court"],
        maxResultCount: 1,
        locationRestriction: {
          circle: { center: { latitude: lat, longitude: lon }, radius: SEARCH_RADIUS },
        },
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const place = data.places?.[0];
    if (!place) return;

    // Places API v1: displayName is {text, languageCode}
    const rawName = place.displayName?.text ?? place.displayName ?? null;
    const name: string = typeof rawName === "string" && rawName.trim()
      ? rawName.trim()
      : "a food place nearby";

    const placeId: string = place.id ?? name;
    const now = Date.now();
    if (lastNotified[placeId] && now - lastNotified[placeId] < COOLDOWN_MS) return;
    lastNotified[placeId] = now;

    await Notifications.scheduleNotificationAsync({
      content: {
        title: `You're at ${name}`,
        body: "Tap to check allergen safety before you order.",
        data: { placeName: name },
      },
      trigger: null,
    });
  } catch {}
}

TaskManager.defineTask(TASK_NAME, ({ data, error }: any) => {
  if (error || !data) return;
  const { locations } = data as { locations: Location.LocationObject[] };
  const loc = locations?.[0];
  if (loc) checkForFoodPlace(loc.coords.latitude, loc.coords.longitude);
});

export async function requestNotificationPermission(): Promise<boolean> {
  const { status } = await Notifications.requestPermissionsAsync();
  return status === "granted";
}

export async function startLocationMonitoring(): Promise<boolean> {
  const { status: fg } = await Location.requestForegroundPermissionsAsync();
  if (fg !== "granted") return false;
  const { status: bg } = await Location.requestBackgroundPermissionsAsync();
  if (bg !== "granted") return false;
  const already = await Location.hasStartedLocationUpdatesAsync(TASK_NAME).catch(() => false);
  if (already) return true;
  await Location.startLocationUpdatesAsync(TASK_NAME, {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: DISTANCE_INTERVAL,
    showsBackgroundLocationIndicator: false,
    pausesUpdatesAutomatically: true,
    activityType: Location.ActivityType.OtherNavigation,
  });
  return true;
}

export async function stopLocationMonitoring() {
  const running = await Location.hasStartedLocationUpdatesAsync(TASK_NAME).catch(() => false);
  if (running) await Location.stopLocationUpdatesAsync(TASK_NAME);
}

export async function isMonitoring(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(TASK_NAME).catch(() => false);
}
