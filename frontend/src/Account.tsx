import { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowLeft,
  Eye,
  EyeOff,
  Check,
  Mail,
  LogOut,
  ShieldCheck,
  Sparkles,
  Plus,
  X,
} from "lucide-react";
import {
  defaultProfile,
  getProfile,
  putProfile,
  startSession,
  endSession,
  openDemo,
  navigate,
  intendedRoute,
  isApiSession,
  BUSINESS_ROLES,
  ORIGIN_OPTIONS,
  DESTINATION_OPTIONS,
  TRANSIT_OPTIONS,
  MAX_TRANSIT_STOPS,
  TEAM_SIZES,
  withCurrent,
  routeStops,
  placeCode,
  type Profile,
} from "./account-store";
import "./account.css";
import { api, cacheAccount, type Account } from "./api";
import { clearChat } from "../ai/chat/Chat";
import {
  signIn,
  signUp,
  verifyEmail,
  resendVerification,
  resetEmail,
  resetPassword,
  signOutAccount,
  signInWithGoogle,
  preloadAuth,
  googleAuthAvailable,
  errorMessage,
  authConfigured,
  devAuth,
} from "./auth";

// Google's "G" mark, as its sign-in branding guidelines ask.
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
function PasswordField({
  label = "Password",
  value,
  onChange,
  id = "password",
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  id?: string;
}) {
  const [visible, setVisible] = useState(false);
  // Sign-in takes whatever password the account has; the 8-character rule is for new ones.
  const isNew = id !== "password";
  return (
    <label className="ac-field" htmlFor={id}>
      {label}
      <span className="ac-password">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          minLength={isNew ? 8 : undefined}
          autoComplete={isNew ? "new-password" : "current-password"}
          placeholder={isNew ? "At least 8 characters" : "Your password"}
        />
        <button
          type="button"
          onClick={() => setVisible(!visible)}
          aria-label={visible ? "Hide password" : "Show password"}
        >
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </span>
    </label>
  );
}
// Where goods ship from, the stops on the way, and where they go. Set at onboarding,
// changed later in Account › About company.
function RouteFields({
  route,
  onChange,
  disabled = false,
}: {
  route: Pick<Profile, "origin" | "transit" | "destination">;
  onChange: (change: Partial<Profile>) => void;
  disabled?: boolean;
}) {
  const nextStop =
    TRANSIT_OPTIONS.find((place) => !route.transit.includes(place)) ||
    TRANSIT_OPTIONS[0];
  return (
    <fieldset className="ac-route ac-wide" disabled={disabled}>
      <legend>Trade route</legend>
      <div className="ac-route-legs">
        <label className="ac-field">
          Ships from
          <select
            value={route.origin}
            onChange={(e) => onChange({ origin: e.target.value })}
          >
            {withCurrent(ORIGIN_OPTIONS, route.origin).map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <div className="ac-field">
          Via (optional)
          {route.transit.map((stop, i) => (
            <span className="ac-route-stop" key={i}>
              <select
                aria-label={`Stop ${i + 1}`}
                value={stop}
                onChange={(e) =>
                  onChange({
                    transit: route.transit.map((s, j) =>
                      j === i ? e.target.value : s,
                    ),
                  })
                }
              >
                {withCurrent(TRANSIT_OPTIONS, stop).map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove stop ${stop}`}
                  onClick={() =>
                    onChange({
                      transit: route.transit.filter((_, j) => j !== i),
                    })
                  }
                >
                  <X size={15} />
                </button>
              )}
            </span>
          ))}
          {!disabled && route.transit.length < MAX_TRANSIT_STOPS && (
            <button
              type="button"
              className="ac-small-link"
              onClick={() =>
                onChange({ transit: [...route.transit, nextStop] })
              }
            >
              <Plus size={13} />
              Add a stop
            </button>
          )}
          {route.transit.length === 0 && disabled && <small>Direct</small>}
        </div>
        <label className="ac-field">
          Primary destination
          <select
            value={route.destination}
            onChange={(e) => onChange({ destination: e.target.value })}
          >
            {withCurrent(DESTINATION_OPTIONS, route.destination).map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="ac-route-preview">{routeStops(route).join(" → ")}</p>
    </fieldset>
  );
}
const COMPANY_FIELDS = [
  "company",
  "role",
  "origin",
  "transit",
  "destination",
  "description",
  "products",
  "materials",
  "certifications",
  "website",
  "foundedYear",
  "teamSize",
] as const;
export function AccountSettings({
  onUpdate,
  account,
}: {
  onUpdate: (account?: Account) => void;
  account: Account | null;
}) {
  const live = isApiSession();
  const [busy, setBusy] = useState(false);
  const [p, setP] = useState(getProfile);
  // Last saved values, so company details are only sent when they changed.
  const [baseline, setBaseline] = useState(getProfile);
  const [saved, setSaved] = useState("");
  // Company details belong to the company: in a connected workspace only its owner edits them.
  const canEditCompany = !live || account?.role === "owner";
  // By value: transit is a list.
  const companyChanged = COMPANY_FIELDS.some(
    (key) => JSON.stringify(p[key]) !== JSON.stringify(baseline[key]),
  );
  const change = (fields: Partial<Profile>) => {
    setP((v) => ({ ...v, ...fields }));
    setSaved("");
  };
  const update = (key: keyof Profile, value: string | boolean) =>
    change({ [key]: value });
  const access = account?.role
    ? account.role[0].toUpperCase() + account.role.slice(1)
    : "";
  return (
    <section className="account-settings">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR WORKSPACE</span>
          <h1>Account.</h1>
        </div>
        <a className="text-link" href="#/logout">
          Sign out
          <LogOut size={16} />
        </a>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          if (live) {
            setBusy(true);
            setSaved("");
            try {
              await api.updateMe({
                name: p.name,
                alerts: p.alerts,
                digest: p.digest,
              });
              if (canEditCompany && companyChanged) await api.updateCompany(p);
              const me = await api.me();
              const fresh = cacheAccount(me);
              setP(fresh);
              setBaseline(fresh);
              setSaved("Saved to your account.");
              onUpdate(me);
            } catch (error) {
              setSaved(errorMessage(error));
            } finally {
              setBusy(false);
            }
            return;
          }
          if (putProfile(p)) {
            setBaseline(p);
            setSaved("Saved in this browser.");
            onUpdate();
          } else
            setSaved("Browser storage is unavailable. Changes were not saved.");
        }}
      >
        <div className="ac-settings-grid">
          <section className="panel">
            <h2>Profile</h2>
            <label className="ac-field">
              Name
              <input
                required
                value={p.name}
                onChange={(e) => update("name", e.target.value)}
              />
            </label>
            <label className="ac-field">
              Email
              <input type="email" value={p.email} readOnly />
              <small>Email changes require backend verification.</small>
            </label>
          </section>
          <section className="panel">
            <h2>Notifications</h2>
            <p className="ac-muted">
              Delivery starts when channels are connected.
            </p>
            {[
              ["alerts", "Order alerts", "When an order needs attention."],
              ["digest", "Weekly summary", "Your top five changes."],
            ].map(([key, title, desc]) => (
              <label className="ac-checkrow" key={key}>
                <span>
                  <b>{title}</b>
                  <small>{desc}</small>
                </span>
                <input
                  type="checkbox"
                  checked={Boolean(p[key as keyof Profile])}
                  onChange={(e) =>
                    update(key as keyof Profile, e.target.checked)
                  }
                />
              </label>
            ))}
            <div className="ac-storage-note">
              <ShieldCheck size={19} />
              <span>
                {live
                  ? "Profile saved to your company account."
                  : "Demo profile. Saved locally."}
              </span>
            </div>
            <a className="text-link" href="#/privacy">
              Privacy details
              <ArrowRight size={15} />
            </a>
          </section>
          <section className="panel ac-company" aria-labelledby="about-company">
            <div className="ac-panel-head">
              <h2 id="about-company">About company</h2>
              <span className="eyebrow">
                {live ? "CREATED AT SIGNUP" : "DEMO COMPANY"}
              </span>
            </div>
            <p className="ac-muted">
              {live
                ? canEditCompany
                  ? "Set up when you signed up. Changes are saved to your company workspace."
                  : "Set up when your company signed up. Only the company owner can change these details."
                : "The demo company from signup. Saved in this browser."}
            </p>
            <div className="ac-kb-note">
              <Sparkles size={16} />
              <span>
                {live
                  ? "The ExportMate assistant reads these details to answer questions about your company, so describe what you make and how in plain words."
                  : "In a company workspace, the ExportMate assistant reads these details to answer questions about your company."}
              </span>
            </div>
            <div className="ac-company-fields">
              <label className="ac-field">
                Company name
                <input
                  required
                  disabled={!canEditCompany}
                  value={p.company}
                  onChange={(e) => update("company", e.target.value)}
                  pattern=".*\S.*"
                />
              </label>
              <label className="ac-field">
                You are a
                <select
                  disabled={!canEditCompany}
                  value={p.role}
                  onChange={(e) => update("role", e.target.value)}
                >
                  {withCurrent(BUSINESS_ROLES, p.role).map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="ac-field ac-wide">
                Company description
                <textarea
                  required={live}
                  disabled={!canEditCompany}
                  maxLength={2000}
                  rows={4}
                  value={p.description}
                  onChange={(e) => update("description", e.target.value)}
                  placeholder="What your company does, where it produces and who it sells to."
                />
                <small>{p.description.length} / 2000</small>
              </label>
              <label className="ac-field ac-wide">
                What you make or sell
                <textarea
                  disabled={!canEditCompany}
                  maxLength={1000}
                  rows={2}
                  value={p.products}
                  onChange={(e) => update("products", e.target.value)}
                  placeholder="e.g. Acacia plywood, engineered flooring, garden furniture"
                />
              </label>
              <label className="ac-field">
                Main materials and origin
                <textarea
                  disabled={!canEditCompany}
                  maxLength={1000}
                  rows={2}
                  value={p.materials}
                  onChange={(e) => update("materials", e.target.value)}
                  placeholder="e.g. Plantation acacia (Vietnam), birch veneer (imported)"
                />
              </label>
              <label className="ac-field">
                Certifications
                <textarea
                  disabled={!canEditCompany}
                  maxLength={1000}
                  rows={2}
                  value={p.certifications}
                  onChange={(e) => update("certifications", e.target.value)}
                  placeholder="e.g. FSC Chain of Custody, VNTLAS, ISO 9001"
                />
              </label>
              <RouteFields
                route={p}
                onChange={change}
                disabled={!canEditCompany}
              />
              <label className="ac-field">
                Website
                <input
                  disabled={!canEditCompany}
                  inputMode="url"
                  maxLength={300}
                  value={p.website}
                  onChange={(e) => update("website", e.target.value)}
                  placeholder="https://yourcompany.com"
                />
              </label>
              <label className="ac-field">
                Year founded
                <input
                  disabled={!canEditCompany}
                  type="number"
                  min={1800}
                  max={new Date().getFullYear()}
                  value={p.foundedYear}
                  onChange={(e) => update("foundedYear", e.target.value)}
                  placeholder="e.g. 2009"
                />
              </label>
              <label className="ac-field">
                Team size
                <select
                  disabled={!canEditCompany}
                  value={p.teamSize}
                  onChange={(e) => update("teamSize", e.target.value)}
                >
                  <option value="">Not set</option>
                  {withCurrent(TEAM_SIZES, p.teamSize).map((v) => (
                    <option key={v} value={v}>
                      {v} people
                    </option>
                  ))}
                </select>
              </label>
              {live && account?.company && (
                <label className="ac-field">
                  Order currency
                  <input value={account.company.currency} readOnly />
                  <small>Set at signup. Imported order values use it.</small>
                </label>
              )}
              {live && access && (
                <label className="ac-field">
                  Your access
                  <input value={access} readOnly />
                  <small>
                    {account?.role === "owner"
                      ? "You can change company details."
                      : "Ask the company owner to change company details."}
                  </small>
                </label>
              )}
            </div>
          </section>
        </div>
        <div className="ac-save">
          <button className="btn" type="submit" disabled={busy}>
            Save changes
            <Check size={16} />
          </button>
          <span role="status">{saved}</span>
        </div>
      </form>
    </section>
  );
}
export default function AccountPage({ route }: { route: string }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [p, setP] = useState(getProfile);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  useEffect(() => {
    setError("");
    setPassword("");
    setConfirm("");
    setDone(false);
    if (route === "onboarding") {
      setP(getProfile());
      setStep(0);
    }
    if (route === "logout") {
      const live = isApiSession();
      endSession();
      // The conversation may mention this company; the next account starts fresh.
      clearChat();
      if (live) {
        setBusy(true);
        api
          .logout()
          .catch((error) =>
            setError(
              `Signed out locally. Could not revoke other sessions: ${errorMessage(error)}`,
            ),
          )
          .finally(() =>
            signOutAccount()
              .catch((error) => setError(errorMessage(error)))
              .finally(() => setBusy(false)),
          );
      }
    }
    if (route === "login" || route === "signup") preloadAuth();
  }, [route]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function enterWorkspace() {
    const account = await api.me();
    cacheAccount(account);
    clearChat();
    if (!startSession("api"))
      throw new Error("Browser storage is unavailable. Enable it to continue.");
    navigate(account.onboarded ? intendedRoute() : "onboarding");
  }
  const completeSignIn = () =>
    run(async () => {
      const verified = await signIn(email.trim(), password);
      setPassword("");
      if (!verified) {
        putProfile({ ...getProfile(), email: email.trim() });
        navigate("verify-email");
        return;
      }
      await enterWorkspace();
    });
  const googleSignIn = () =>
    run(async () => {
      endSession();
      const google = await signInWithGoogle();
      if (!google) return; // the Google window was closed
      if (!google.verified) {
        // A Google account can use an address Google hasn't confirmed.
        putProfile({ ...getProfile(), email: google.email });
        navigate("verify-email");
        return;
      }
      await enterWorkspace();
    });
  const googleButton = googleAuthAvailable && (
    <button
      className="ac-secondary ac-google"
      type="button"
      onClick={googleSignIn}
      disabled={busy}
    >
      <GoogleMark />
      Continue with Google
    </button>
  );
  const signup = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      endSession();
      await signUp(name.trim(), email.trim(), password);
      putProfile({
        ...defaultProfile,
        name: name.trim(),
        email: email.trim(),
        company: "",
        onboarded: false,
      });
      setPassword("");
      if (devAuth) await enterWorkspace();
      else navigate("verify-email");
    });
  };
  const titles: Record<string, [string, string]> = {
    login: ["BACK IN", "BUSINESS."],
    signup: ["ROOM TO", "GROW."],
    "verify-email": ["ONE LAST", "CHECK."],
    "forgot-password": ["LET’S GET", "YOU BACK."],
    "check-email": ["CHECK YOUR", "INBOX."],
    "reset-password": ["A FRESH", "START."],
    onboarding: ["YOUR WORLD.", "CONNECTED."],
    logout: ["UNTIL", "NEXT TIME."],
    privacy: ["YOUR DATA.", "YOUR CALL."],
    terms: ["A CLEAR", "START."],
  };
  const title = titles[route] || ["OFF THE", "MAP."];
  return (
    <div className="account-stage">
      <header className="ac-header">
        <a className="lp-wordmark" href="#/">
          ExportMate<span>®</span>
        </a>
        <a className="text-link" href="#/">
          <ArrowLeft size={15} />
          Back home
        </a>
      </header>
      <main className="account-layout">
        <aside className="ac-visual">
          <img src="/trade-desk.png" alt="Vintage shipping operations desk" />
          <div />
          <span className="lp-kicker">TRADE, WITH PERSPECTIVE.</span>
          <h1>
            {title[0]}
            <br />
            <strong>{title[1]}</strong>
          </h1>
          <span className="ac-visual-footer">
            {routeStops(p).map(placeCode).join(" — ")} <span>EST. 2026</span>
          </span>
        </aside>
        <section className="ac-form-pane">
          <div className="ac-form-inner">
            {route === "login" && (
              <>
                <span className="ac-index">01 / ACCOUNT ACCESS</span>
                <h2>Welcome back.</h2>
                <p className="ac-lead">Your orders are waiting.</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    completeSignIn();
                  }}
                >
                  <label className="ac-field">
                    Email
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="email"
                      placeholder="you@company.com"
                    />
                  </label>
                  <PasswordField value={password} onChange={setPassword} />
                  <a className="ac-small-link" href="#/forgot-password">
                    Forgot password?
                  </a>
                  <button className="ac-primary" type="submit" disabled={busy}>
                    Sign in
                    <ArrowRight size={18} />
                  </button>
                </form>
                <div className="ac-divider">
                  <span>or</span>
                </div>
                {googleButton}
                <button className="ac-secondary" onClick={openDemo}>
                  Explore the demo
                  <ArrowRight size={16} />
                </button>
                <p className="ac-switch">
                  New here? <a href="#/signup">Create an account</a>
                </p>
              </>
            )}
            {route === "signup" && (
              <>
                <span className="ac-index">01 / GET STARTED</span>
                <h2>Make your move.</h2>
                <p className="ac-lead">Start with your company.</p>
                <form onSubmit={signup}>
                  <label className="ac-field">
                    Full name
                    <input
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoComplete="name"
                      placeholder="Your name"
                      pattern=".*\S.*"
                    />
                  </label>
                  <label className="ac-field">
                    Work email
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="email"
                      placeholder="you@company.com"
                    />
                  </label>
                  <PasswordField
                    id="new-password"
                    value={password}
                    onChange={setPassword}
                  />
                  <label className="ac-consent">
                    <input type="checkbox" required />
                    <span>
                      I’ve read the{" "}
                      <a href="#/terms" target="_blank" rel="noopener">
                        terms
                      </a>{" "}
                      and{" "}
                      <a href="#/privacy" target="_blank" rel="noopener">
                        privacy details
                      </a>
                      .
                    </span>
                  </label>
                  <button className="ac-primary" type="submit" disabled={busy}>
                    Create account
                    <ArrowRight size={18} />
                  </button>
                </form>
                {googleButton && (
                  <>
                    <div className="ac-divider">
                      <span>or</span>
                    </div>
                    {googleButton}
                    <p className="ac-consent">
                      <span>
                        By continuing with Google you agree to the{" "}
                        <a href="#/terms" target="_blank" rel="noopener">
                          terms
                        </a>{" "}
                        and{" "}
                        <a href="#/privacy" target="_blank" rel="noopener">
                          privacy details
                        </a>
                        .
                      </span>
                    </p>
                  </>
                )}
                <p className="ac-switch">
                  Already here? <a href="#/login">Sign in</a>
                </p>
              </>
            )}
            {route === "verify-email" && (
              <>
                <Mail className="ac-large-icon" size={40} />
                <h2>Verify your email.</h2>
                <p className="ac-lead">{getProfile().email}</p>
                <div className="ac-preview-box">
                  Open the verification link sent to your email, then continue
                  here.
                </div>
                <button
                  className="ac-primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const code = new URLSearchParams(location.search).get(
                        "oobCode",
                      );
                      let signedIn: boolean;
                      try {
                        signedIn = await verifyEmail(code);
                      } finally {
                        // The code works once; drop it so a retry doesn't reuse it.
                        if (code)
                          history.replaceState(
                            null,
                            "",
                            location.pathname + location.hash,
                          );
                      }
                      if (!signedIn) {
                        navigate("login");
                        setNotice("Email verified. Sign in to continue.");
                        return;
                      }
                      await enterWorkspace();
                    })
                  }
                >
                  I’ve verified my email
                  <ArrowRight size={18} />
                </button>
                <button
                  className="ac-small-link"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await resendVerification();
                      setNotice("Verification email sent.");
                    })
                  }
                >
                  Resend verification email
                </button>
                <a className="ac-small-link" href="#/signup">
                  Use another email
                </a>
              </>
            )}
            {route === "forgot-password" && (
              <>
                <span className="ac-index">ACCOUNT RECOVERY</span>
                <h2>Forgot your password?</h2>
                <p className="ac-lead">Start with your email.</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      await resetEmail(email.trim());
                      setPassword("");
                      navigate("check-email");
                    });
                  }}
                >
                  <label className="ac-field">
                    Email
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@company.com"
                      autoComplete="email"
                    />
                  </label>
                  <button className="ac-primary" type="submit" disabled={busy}>
                    Continue
                    <ArrowRight size={18} />
                  </button>
                </form>
                <a className="ac-small-link" href="#/login">
                  Back to sign in
                </a>
              </>
            )}
            {route === "check-email" && (
              <>
                <Mail className="ac-large-icon" size={40} />
                <h2>Check your email.</h2>
                <p className="ac-lead">
                  If an account matches, you’ll receive a password reset link.
                </p>
                <div className="ac-preview-box">
                  Open the secure link in your email to choose a new password.
                </div>
                <a className="ac-small-link" href="#/forgot-password">
                  Try another email
                </a>
              </>
            )}
            {route === "reset-password" &&
              (done ? (
                <>
                  <Check className="ac-large-icon" size={40} />
                  <h2>Password updated.</h2>
                  <p className="ac-lead">
                    You can now sign in with your new password.
                  </p>
                  <a className="ac-primary" href="#/login">
                    Back to sign in
                    <ArrowRight size={18} />
                  </a>
                </>
              ) : (
                <>
                  <span className="ac-index">ACCOUNT RECOVERY</span>
                  <h2>Choose a password.</h2>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (password !== confirm) {
                        setError("Passwords don’t match.");
                        return;
                      }
                      void run(async () => {
                        const code = new URLSearchParams(location.search).get(
                          "oobCode",
                        );
                        if (!code)
                          throw new Error(
                            "Open the password reset link from your email.",
                          );
                        await resetPassword(code, password);
                        setPassword("");
                        setConfirm("");
                        setDone(true);
                        history.replaceState(
                          null,
                          "",
                          location.pathname + location.hash,
                        );
                      });
                    }}
                  >
                    <PasswordField
                      id="new-password"
                      label="New password"
                      value={password}
                      onChange={setPassword}
                    />
                    <PasswordField
                      id="confirm-password"
                      label="Confirm password"
                      value={confirm}
                      onChange={setConfirm}
                    />
                    <button
                      className="ac-primary"
                      type="submit"
                      disabled={busy}
                    >
                      Reset password
                      <ArrowRight size={18} />
                    </button>
                  </form>
                </>
              ))}
            {route === "onboarding" && (
              <>
                <div className="ac-onboarding-progress">
                  {["Company", "Trade", "Ready"].map((s, i) => (
                    <span key={s} className={i <= step ? "active" : ""}>
                      {i < step ? <Check size={12} /> : i + 1} {s}
                    </span>
                  ))}
                </div>
                <h2>
                  {["Your company.", "Your corridor.", "Ready to go."][step]}
                </h2>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (step === 0 && !p.description.trim()) {
                      setError("Describe what your company does.");
                      return;
                    }
                    setError("");
                    if (step < 2) {
                      setStep(step + 1);
                      return;
                    }
                    void run(async () => {
                      const account = await api.onboard(p);
                      cacheAccount(account);
                      startSession("api");
                      navigate("workspace/data");
                    });
                  }}
                >
                  {step === 0 && (
                    <>
                      <label className="ac-field">
                        Company name
                        <input
                          required
                          value={p.company}
                          onChange={(e) =>
                            setP({ ...p, company: e.target.value })
                          }
                          placeholder="Your company"
                          pattern=".*\S.*"
                        />
                      </label>
                      <label className="ac-field">
                        You are a
                        <select
                          value={p.role}
                          onChange={(e) => setP({ ...p, role: e.target.value })}
                        >
                          {BUSINESS_ROLES.map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                      <label className="ac-field">
                        What does your company do?
                        <textarea
                          required
                          maxLength={2000}
                          rows={4}
                          value={p.description}
                          onChange={(e) =>
                            setP({ ...p, description: e.target.value })
                          }
                          placeholder="What you make, where you produce and who you sell to."
                        />
                        <small>
                          The ExportMate assistant uses this to answer
                          questions about your company. You can add more in
                          Account later.
                        </small>
                      </label>
                    </>
                  )}
                  {step === 1 && (
                    <>
                      <RouteFields
                        route={p}
                        onChange={(change) => setP({ ...p, ...change })}
                      />
                      <p className="ac-muted">
                        Add the hubs your goods pass through, such as
                        Singapore, or remove them for a direct route. You can
                        change your route later in Account.
                      </p>
                    </>
                  )}
                  {step === 2 && (
                    <div className="ac-review">
                      <span>{p.name}</span>
                      <h3>{p.company}</h3>
                      <p>{p.role}</p>
                      <p className="ac-review-description">{p.description}</p>
                      <b>{routeStops(p).join(" → ")}</b>
                      <p>Next: import your orders.</p>
                    </div>
                  )}
                  <button className="ac-primary" type="submit" disabled={busy}>
                    {step === 2 ? "Open workspace" : "Continue"}
                    <ArrowRight size={18} />
                  </button>
                  {step > 0 && (
                    <button
                      className="ac-small-link"
                      type="button"
                      onClick={() => setStep(step - 1)}
                    >
                      <ArrowLeft size={13} />
                      Back
                    </button>
                  )}
                </form>
              </>
            )}
            {route === "logout" && (
              <>
                <LogOut className="ac-large-icon" size={38} />
                <h2>You’re signed out.</h2>
                <p className="ac-lead">
                  {busy ? "Ending your session…" : "Your workspace is saved."}
                </p>
                <a className="ac-primary" href="#/login">
                  Sign in again
                  <ArrowRight size={18} />
                </a>
                <a className="ac-small-link" href="#/">
                  Back home
                </a>
              </>
            )}
            {route === "privacy" && (
              <>
                <span className="ac-index">PROTOTYPE INFORMATION</span>
                <h2>Your data.</h2>
                <div className="ac-policy">
                  <h3>Stored here</h3>
                  <p>
                    Sample-demo records and inquiry drafts stay in this browser.
                    Signed-in company orders, imports, profiles and playbook
                    rules are stored by the backend. Firebase handles account
                    credentials; this app does not store passwords.
                  </p>
                  <h3>External requests</h3>
                  <p>
                    Fonts load from Google Fonts. Account requests go to
                    Firebase and the company backend. Chat and news use the AI
                    service; chat questions and answers are stored in its audit
                    trail.
                  </p>
                  <h3>Your control</h3>
                  <p>
                    Sign out ends the demo session. Clear this site's browser
                    data to remove saved records. Use sample data only.
                  </p>
                  <p>
                    This describes the prototype. A reviewed production policy
                    is still required.
                  </p>
                </div>
              </>
            )}
            {route === "terms" && (
              <>
                <span className="ac-index">PROTOTYPE INFORMATION</span>
                <h2>Before you start.</h2>
                <div className="ac-policy">
                  <h3>A product preview</h3>
                  <p>
                    Account and company data are saved through connected
                    services when configured. Rule-change simulations and
                    supplier messages remain demonstrations; no supplier message
                    is delivered.
                  </p>
                  <h3>Sample decisions</h3>
                  <p>
                    Regulatory text and cost figures are illustrative. Do not
                    use them to make shipment or compliance decisions.
                  </p>
                  <h3>Before launch</h3>
                  <p>
                    Production terms, privacy review and backend access controls
                    remain to be completed.
                  </p>
                </div>
                <a className="ac-small-link" href="#/signup">
                  Create an account
                  <ArrowRight size={15} />
                </a>
              </>
            )}
            {!titles[route] && (
              <>
                <span className="ac-index">404 / NOT FOUND</span>
                <h2>Wrong turn.</h2>
                <p className="ac-lead">This page isn’t on the map.</p>
                <a className="ac-primary" href="#/">
                  Back home
                  <ArrowRight size={18} />
                </a>
              </>
            )}
            {notice && <p role="status">{notice}</p>}
            {error && (
              <p className="ac-error" role="alert">
                {error}
              </p>
            )}
            {!["privacy", "terms", "logout"].includes(route) && (
              <p className="ac-demo-note">
                {authConfigured
                  ? devAuth
                    ? "LOCAL DEVELOPMENT SIGN-IN"
                    : "SECURE ACCOUNT ACCESS"
                  : "ACCOUNT SETUP PENDING"}
                <br />
                <span>
                  {authConfigured
                    ? "Your orders and settings are saved to your company workspace."
                    : "Account access needs deployment configuration. The sample demo is available from the home page."}
                </span>
              </p>
            )}
          </div>
        </section>
      </main>
      <footer className="ac-footer">
        <span>EXPORTMATE © 2026</span>
        <a href="#/privacy">Privacy</a>
        <a href="#/terms">Terms</a>
      </footer>
    </div>
  );
}
