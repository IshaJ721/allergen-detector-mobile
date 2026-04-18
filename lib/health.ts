// Apple HealthKit — requires paid Apple Developer account ($99/yr) to provision entitlement.
// Kept as a stub so the UI compiles; the button shows a graceful message when tapped.

export const isHealthAvailable = false;

export function initHealth(): Promise<boolean> {
  return Promise.resolve(false);
}

export function logAllergenExposure(
  _dishName: string,
  _highRiskAllergens: string[]
): Promise<{ success: boolean; message: string }> {
  return Promise.resolve({
    success: false,
    message: "Apple Health requires a paid Apple Developer account to activate.",
  });
}
