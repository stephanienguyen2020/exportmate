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
  type Profile,
} from "./account-store";
import "./account.css";
import { api, cacheAccount, type Account } from "./api";
import {
  signIn,
  signUp,
  verifyEmail,
  resendVerification,
  resetEmail,
  resetPassword,
  signOutAccount,
  errorMessage,
  authConfigured,
  devAuth,
} from "./auth";
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
          minLength={8}
          autoComplete={id === "password" ? "current-password" : "new-password"}
          placeholder="At least 8 characters"
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
export function AccountSettings({
  onUpdate,
  account,
}: {
  onUpdate: () => void;
  account: Account | null;
}) {
  const live = isApiSession();
  const [busy, setBusy] = useState(false);
  const [p, setP] = useState(getProfile);
  const [saved, setSaved] = useState("");
  const update = (key: keyof Profile, value: string | boolean) => {
    setP((v) => ({ ...v, [key]: value }));
    setSaved("");
  };
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
              if (account?.role === "owner") await api.updateCompany(p);
              cacheAccount(await api.me());
              setSaved("Saved to your account.");
              onUpdate();
            } catch (error) {
              setSaved(errorMessage(error));
            } finally {
              setBusy(false);
            }
            return;
          }
          if (putProfile(p)) {
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
            <label className="ac-field">
              Company
              <input
                required
                disabled={live && account?.role !== "owner"}
                value={p.company}
                onChange={(e) => update("company", e.target.value)}
              />
            </label>
            <label className="ac-field">
              Role
              <select
                disabled={live && account?.role !== "owner"}
                value={p.role}
                onChange={(e) => update("role", e.target.value)}
              >
                <option>Manufacturer</option>
                <option>Buyer / trader</option>
              </select>
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
            VN — SG — EU <span>EST. 2026</span>
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
                <button className="ac-secondary" onClick={openDemo}>
                  Explore the demo
                  <ArrowUp />
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
                      await verifyEmail(
                        new URLSearchParams(location.search).get("oobCode"),
                      );
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
                          <option>Manufacturer</option>
                          <option>Buyer / trader</option>
                        </select>
                      </label>
                    </>
                  )}
                  {step === 1 && (
                    <>
                      <label className="ac-field">
                        Based in
                        <select
                          value={p.origin}
                          onChange={(e) =>
                            setP({ ...p, origin: e.target.value })
                          }
                        >
                          {[
                            "Vietnam",
                            "Singapore",
                            "Indonesia",
                            "Thailand",
                            "Other",
                          ].map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                      <label className="ac-field">
                        Primary destination
                        <select
                          value={p.destination}
                          onChange={(e) =>
                            setP({ ...p, destination: e.target.value })
                          }
                        >
                          {[
                            "European Union",
                            "Singapore",
                            "United States",
                            "Japan",
                            "Other",
                          ].map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                      <p className="ac-muted">
                        The demo analyses the VN → SG → EU corridor.
                      </p>
                    </>
                  )}
                  {step === 2 && (
                    <div className="ac-review">
                      <span>{p.name}</span>
                      <h3>{p.company}</h3>
                      <p>{p.role}</p>
                      <b>
                        {p.origin} → {p.destination}
                      </b>
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
                  Create a demo profile
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
function ArrowUp() {
  return <ArrowRight size={16} />;
}
