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
  type Profile,
} from "./account-store";
import "./account.css";
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
export function AccountSettings({ onUpdate }: { onUpdate: () => void }) {
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
        onSubmit={(e) => {
          e.preventDefault();
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
                value={p.company}
                onChange={(e) => update("company", e.target.value)}
              />
            </label>
            <label className="ac-field">
              Role
              <select
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
                Demo profile. Saved locally.
                <br />
                No passwords are stored.
              </span>
            </div>
            <a className="text-link" href="#/privacy">
              Privacy details
              <ArrowRight size={15} />
            </a>
          </section>
        </div>
        <div className="ac-save">
          <button className="btn" type="submit">
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
    if (route === "logout") endSession();
  }, [route]);
  const completeSignIn = () => {
    if (!startSession()) {
      setError("Browser storage is unavailable. Enable it to continue.");
      return;
    }
    const profile = {
      ...getProfile(),
      email: email.trim() || getProfile().email,
    };
    if (!putProfile(profile)) {
      setError("Profile could not be saved.");
      return;
    }
    navigate(intendedRoute());
  };
  const signup = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) return;
    const profile = {
      ...defaultProfile,
      name: name.trim(),
      email: email.trim(),
      company: "",
      onboarded: false,
    };
    if (!putProfile(profile)) {
      setError("Browser storage is unavailable.");
      return;
    }
    endSession();
    setP(profile);
    setPassword("");
    navigate("verify-email");
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
                  <button className="ac-primary" type="submit">
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
                  <button className="ac-primary" type="submit">
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
                  Preview only. No verification email was sent.
                </div>
                <button
                  className="ac-primary"
                  onClick={() => {
                    if (startSession()) navigate("onboarding");
                    else setError("Browser storage is unavailable.");
                  }}
                >
                  Preview verification
                  <ArrowRight size={18} />
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
                    setPassword("");
                    navigate("check-email");
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
                  <button className="ac-primary" type="submit">
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
                <h2>Recovery, previewed.</h2>
                <p className="ac-lead">No reset email was sent.</p>
                <div className="ac-preview-box">
                  Explore the next screen without an email token.
                </div>
                <button
                  className="ac-primary"
                  onClick={() => navigate("reset-password")}
                >
                  Preview password reset
                  <ArrowRight size={18} />
                </button>
                <a className="ac-small-link" href="#/forgot-password">
                  Try another email
                </a>
              </>
            )}
            {route === "reset-password" &&
              (done ? (
                <>
                  <Check className="ac-large-icon" size={40} />
                  <h2>Reset preview complete.</h2>
                  <p className="ac-lead">No account password was changed.</p>
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
                      setPassword("");
                      setConfirm("");
                      setError("");
                      setDone(true);
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
                    <button className="ac-primary" type="submit">
                      Preview reset
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
                    if (putProfile({ ...p, onboarded: true }) && startSession())
                      navigate("workspace/data");
                    else setError("Browser storage is unavailable.");
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
                  <button className="ac-primary" type="submit">
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
                <p className="ac-lead">Your local workspace is saved.</p>
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
                    Demo profile, preferences, imports, playbook rules and
                    inquiry drafts stay in this browser. The session uses
                    session storage. Passwords are never stored.
                  </p>
                  <h3>External requests</h3>
                  <p>
                    Fonts load from Google Fonts. No analytics, account service
                    or message provider is connected.
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
                    Account flows, rule analyses and supplier messages are
                    demonstrations. No real account is created and no message is
                    delivered.
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
            {error && (
              <p className="ac-error" role="alert">
                {error}
              </p>
            )}
            {!["privacy", "terms", "logout"].includes(route) && (
              <p className="ac-demo-note">
                DEMO FLOW · USE SAMPLE DETAILS
                <br />
                <span>No authentication or email service connected.</span>
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
