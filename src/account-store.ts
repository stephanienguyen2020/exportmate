export type Profile = {
  name: string;
  email: string;
  company: string;
  role: string;
  origin: string;
  destination: string;
  alerts: boolean;
  digest: boolean;
  onboarded: boolean;
};
export const defaultProfile: Profile = {
  name: "Ms. Lan",
  email: "lan@example.com",
  company: "Binh Duong Wood Co.",
  role: "Manufacturer",
  origin: "Vietnam",
  destination: "European Union",
  alerts: true,
  digest: true,
  onboarded: false,
};
export function getProfile(): Profile {
  try {
    const p = JSON.parse(localStorage.getItem("em-profile") || "null");
    if (
      p &&
      Object.entries(defaultProfile).every(
        ([key, value]) => typeof p[key] === typeof value,
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
