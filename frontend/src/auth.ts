import type { Auth } from "firebase/auth";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
// Development tokens are deliberately limited to the local Vite development server.
export const devAuth =
  import.meta.env.DEV && import.meta.env.VITE_AUTH_MODE === "dev";
const firebaseConfigured = Boolean(config.apiKey && config.projectId);
export const authConfigured = devAuth || firebaseConfigured;

// The Firebase SDK is a large download, so it loads on first use (sign-in, or the first
// API call of a connected session) instead of with every page.
let loading: Promise<{
  auth: Auth;
  sdk: typeof import("firebase/auth");
}> | null = null;
function firebase() {
  if (!firebaseConfigured)
    throw new Error(
      "Account sign-in is not configured yet. You can still explore the sample demo.",
    );
  loading ??= (async () => {
    const [{ initializeApp }, sdk] = await Promise.all([
      import("firebase/app"),
      import("firebase/auth"),
    ]);
    const auth = sdk.getAuth(initializeApp(config));
    await sdk.setPersistence(auth, sdk.browserSessionPersistence);
    await auth.authStateReady();
    return { auth, sdk };
  })();
  loading.catch(() => (loading = null)); // a failed download can be retried
  return loading;
}
// Google sign-in goes through Firebase, so local dev tokens can't stand in for it.
export const googleAuthAvailable = firebaseConfigured && !devAuth;
// Browsers block a popup opened long after the click, so the sign-in pages load the SDK early.
export function preloadAuth() {
  if (googleAuthAvailable) firebase().catch(() => {});
}
/** Returns null when the person closes the Google window. */
export async function signInWithGoogle() {
  const { auth, sdk } = await firebase();
  const provider = new sdk.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    const { user } = await sdk.signInWithPopup(auth, provider);
    return { email: user.email || "", verified: user.emailVerified };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (
      code === "auth/popup-closed-by-user" ||
      code === "auth/cancelled-popup-request"
    )
      return null;
    throw error;
  }
}
export async function signIn(email: string, password: string) {
  if (devAuth) {
    sessionStorage.setItem("em-dev-email", email);
    return true;
  }
  const { auth, sdk } = await firebase();
  const { user } = await sdk.signInWithEmailAndPassword(auth, email, password);
  return user.emailVerified;
}
export async function signUp(name: string, email: string, password: string) {
  if (devAuth) {
    sessionStorage.setItem("em-dev-email", email);
    return;
  }
  const { auth, sdk } = await firebase();
  const { user } = await sdk.createUserWithEmailAndPassword(
    auth,
    email,
    password,
  );
  await sdk.updateProfile(user, { displayName: name });
  await sdk.sendEmailVerification(user);
}
/**
 * Applies the verification link's code (if any) and refreshes the token.
 * Returns false when the email is verified but nobody is signed in in this browser,
 * e.g. the link was opened on another device.
 */
export async function verifyEmail(code?: string | null) {
  if (devAuth) return true;
  const { auth, sdk } = await firebase();
  if (code) await sdk.applyActionCode(auth, code);
  if (!auth.currentUser) {
    if (code) return false;
    throw new Error("Sign in first, then check your email verification.");
  }
  await auth.currentUser.reload();
  if (!auth.currentUser.emailVerified)
    throw new Error(
      "Open the verification link in your email, then try again.",
    );
  await auth.currentUser.getIdToken(true);
  return true;
}
export async function resendVerification() {
  const { auth, sdk } = await firebase();
  if (!auth.currentUser)
    throw new Error("Sign in before requesting a new verification email.");
  await sdk.sendEmailVerification(auth.currentUser);
}
export async function resetEmail(email: string) {
  const { auth, sdk } = await firebase();
  await sdk.sendPasswordResetEmail(auth, email);
}
export async function resetPassword(code: string, password: string) {
  const { auth, sdk } = await firebase();
  await sdk.confirmPasswordReset(auth, code, password);
}
export async function getToken() {
  if (devAuth) {
    const email = sessionStorage.getItem("em-dev-email");
    if (email) return `dev:${email}`;
  }
  const { auth } = await firebase();
  if (!auth.currentUser)
    throw new Error("Your session ended. Please sign in again.");
  return auth.currentUser.getIdToken();
}
export async function signOutAccount() {
  sessionStorage.removeItem("em-dev-email");
  if (!firebaseConfigured) return;
  const { auth, sdk } = await firebase();
  await sdk.signOut(auth);
}
// Plain-language versions of the Firebase errors people actually hit.
const FIREBASE_MESSAGES: Record<string, string> = {
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/wrong-password": "Email or password is incorrect.",
  "auth/user-not-found": "Email or password is incorrect.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/missing-password": "Enter your password.",
  "auth/email-already-in-use":
    "An account with this email already exists. Sign in instead.",
  "auth/weak-password": "Choose a stronger password of at least 8 characters.",
  "auth/too-many-requests":
    "Too many attempts. Wait a few minutes, then try again.",
  "auth/network-request-failed":
    "Can't reach the sign-in service. Check your connection and try again.",
  "auth/user-disabled": "This account has been disabled.",
  "auth/expired-action-code": "This link has expired. Request a new one.",
  "auth/invalid-action-code":
    "This link is invalid or was already used. Request a new one.",
  "auth/requires-recent-login": "Sign in again to continue.",
  "auth/popup-blocked":
    "Your browser blocked the Google window. Allow pop-ups for this site, then try again.",
  "auth/account-exists-with-different-credential":
    "This email already has an ExportMate password. Sign in with your email and password.",
  "auth/operation-not-allowed":
    "Google sign-in isn't turned on yet. Use your email and password.",
  "auth/unauthorized-domain":
    "Google sign-in isn't set up for this address yet. Use your email and password.",
};
export function errorMessage(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("auth/"))
    return (
      FIREBASE_MESSAGES[code] || "Sign-in didn't work. Please try again."
    );
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
