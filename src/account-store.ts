export type Profile = {
  name: string;
  email: string;
  company: string;
  role: string;
  origin: string;
  // Stops between origin and destination, in order; empty means the route is direct.
  transit: string[];
  destination: string;
  // About company; also what the AI assistant knows about the company.
  description: string;
  products: string;
  materials: string;
  certifications: string;
  website: string;
  foundedYear: string;
  teamSize: string;
  alerts: boolean;
  digest: boolean;
  onboarded: boolean;
};
// Company choices offered at onboarding and in Account › About company.
// BUSINESS_ROLES must match BusinessRole in backend/app/schemas/account.py.
export const BUSINESS_ROLES = ["Manufacturer", "Buyer / trader"];
export const ORIGIN_OPTIONS = [
  "Vietnam",
  "Singapore",
  "Indonesia",
  "Thailand",
  "Other",
];
export const DESTINATION_OPTIONS = [
  "European Union",
  "Singapore",
  "United States",
  "Japan",
  "Other",
];
export const TRANSIT_OPTIONS = [
  "Singapore",
  "Malaysia",
  "Hong Kong",
  "China",
  "Sri Lanka",
  "United Arab Emirates",
  "Other",
];
// Must match MAX_TRANSIT_STOPS in backend/app/schemas/account.py.
export const MAX_TRANSIT_STOPS = 3;
// Short codes for the corridor badge (VN → SG → EU); unlisted places use their first letters.
const PLACE_CODES: Record<string, string> = {
  Vietnam: "VN",
  Singapore: "SG",
  Indonesia: "ID",
  Thailand: "TH",
  Malaysia: "MY",
  "Hong Kong": "HK",
  China: "CN",
  "Sri Lanka": "LK",
  "United Arab Emirates": "AE",
  "European Union": "EU",
  "United States": "US",
  Japan: "JP",
};
export const placeCode = (place: string) =>
  PLACE_CODES[place] || place.slice(0, 3).toUpperCase();
export const routeStops = (
  p: Pick<Profile, "origin" | "transit" | "destination">,
) => [p.origin, ...p.transit, p.destination];
// Must match TeamSize in backend/app/schemas/account.py.
export const TEAM_SIZES = ["1-10", "11-50", "51-200", "201-500", "500+"];
// Keeps a value saved earlier selectable even if it's no longer a listed choice.
export const withCurrent = (options: string[], current: string) =>
  current && !options.includes(current) ? [current, ...options] : options;
export const defaultProfile: Profile = {
  name: "Ms. Lan",
  email: "lan@example.com",
  company: "Binh Duong Wood Co.",
  role: "Manufacturer",
  origin: "Vietnam",
  transit: ["Singapore"],
  destination: "European Union",
  description: "",
  products: "",
  materials: "",
  certifications: "",
  website: "",
  foundedYear: "",
  teamSize: "",
  alerts: true,
  digest: true,
  onboarded: false,
};
export function getProfile(): Profile {
  try {
    const p = JSON.parse(localStorage.getItem("em-profile") || "null");
    // Fields added later may be missing from a saved profile; present ones must match.
    if (
      p &&
      typeof p === "object" &&
      Object.entries(defaultProfile).every(
        ([key, value]) =>
          !(key in p) ||
          (Array.isArray(value)
            ? Array.isArray(p[key])
            : typeof p[key] === typeof value),
      )
    )
      return { ...defaultProfile, ...p };
  } catch {}
  return { ...defaultProfile };
}
export function putProfile(p: Profile) {
  try {
    localStorage.setItem("em-profile", JSON.stringify(p));
    return true;
  } catch {
    return false;
  }
}
export function hasSession() {
  try {
    return ["demo", "api"].includes(sessionStorage.getItem("em-session") || "");
  } catch {
    return false;
  }
}
export function isApiSession() {
  return sessionStorage.getItem("em-session") === "api";
}
export function startSession(mode: "demo" | "api" = "demo") {
  try {
    sessionStorage.setItem("em-session", mode);
    return true;
  } catch {
    return false;
  }
}
export function endSession() {
  try {
    sessionStorage.removeItem("em-session");
  } catch {}
}
export function openDemo() {
  if (startSession()) location.hash = "/workspace";
  else alert("Please enable browser storage to open the demo.");
}
export function navigate(path: string) {
  location.hash = "/" + path;
  window.scrollTo(0, 0);
}
export function intendedRoute() {
  try {
    const p = sessionStorage.getItem("em-next");
    sessionStorage.removeItem("em-next");
    return p &&
      /^workspace(?:\/(?:orders(?:\/[^?#]+)?|rules|data|playbook|account))?$/.test(
        p,
      )
      ? p
      : "workspace";
  } catch {
    return "workspace";
  }
}
