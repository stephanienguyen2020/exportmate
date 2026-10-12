import { initializeApp } from "firebase/app";
import {
  getAuth,
  setPersistence,
  browserSessionPersistence,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendEmailVerification,
  sendPasswordResetEmail,
  confirmPasswordReset,
  applyActionCode,
  signOut,
} from "firebase/auth";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
// Development tokens are deliberately limited to the local Vite development server.
export const devAuth =
  import.meta.env.DEV && import.meta.env.VITE_AUTH_MODE === "dev";
export const authConfigured =
  devAuth || Boolean(config.apiKey && config.projectId);
const auth =
  config.apiKey && config.projectId ? getAuth(initializeApp(config)) : null;
const ready = auth
  ? setPersistence(auth, browserSessionPersistence).then(() =>
      auth.authStateReady(),
    )
  : Promise.resolve();
function requireAuth() {
  if (!auth)
    throw new Error(
      "Account sign-in is not configured yet. You can still explore the sample demo.",
    );
  return auth;
}
export async function signIn(email: string, password: string) {
  if (devAuth) {
    sessionStorage.setItem("em-dev-email", email);
    return true;
  }
  await ready;
  const { user } = await signInWithEmailAndPassword(
    requireAuth(),
    email,
    password,
  );
  return user.emailVerified;
}
export async function signUp(name: string, email: string, password: string) {
  if (devAuth) {
    sessionStorage.setItem("em-dev-email", email);
    return;
  }
  await ready;
  const { user } = await createUserWithEmailAndPassword(
    requireAuth(),
    email,
    password,
  );
  await updateProfile(user, { displayName: name });
  await sendEmailVerification(user);
}
export async function verifyEmail(code?: string | null) {
  if (devAuth) return;
  await ready;
  const client = requireAuth();
  if (code) await applyActionCode(client, code);
  if (!client.currentUser)
    throw new Error("Sign in first, then check your email verification.");
  await client.currentUser.reload();
  if (!client.currentUser.emailVerified)
    throw new Error(
      "Open the verification link in your email, then try again.",
    );
  await client.currentUser.getIdToken(true);
}
export async function resendVerification() {
  await ready;
  const user = requireAuth().currentUser;
  if (!user)
    throw new Error("Sign in before requesting a new verification email.");
  await sendEmailVerification(user);
}
export async function resetEmail(email: string) {
  await ready;
  await sendPasswordResetEmail(requireAuth(), email);
}
export async function resetPassword(code: string, password: string) {
  await confirmPasswordReset(requireAuth(), code, password);
}
export async function getToken() {
  if (devAuth) {
    const email = sessionStorage.getItem("em-dev-email");
    if (email) return `dev:${email}`;
  }
  await ready;
  const user = requireAuth().currentUser;
  if (!user) throw new Error("Your session ended. Please sign in again.");
  return user.getIdToken();
}
export async function signOutAccount() {
  await ready;
  sessionStorage.removeItem("em-dev-email");
  if (auth) await signOut(auth);
}
export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
