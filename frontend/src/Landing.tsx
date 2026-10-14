import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  FileText,
  Upload,
  ShieldCheck,
  Send,
  ArrowDown,
} from "lucide-react";
import { openDemo } from "./account-store";
import "./landing.css";
import "./landing-sections.css";
const TradeGlobe = lazy(() => import("./TradeGlobe"));
const steps = [
  {
    n: "01",
    title: "Bring your orders.",
    description: "One spreadsheet. Your actual business.",
    icon: Upload,
    label: "ORDERS.CSV",
    value: "12 open orders",
    status: "Ready to review",
  },
  {
    n: "02",
    title: "Spot the impact.",
    description: "See the order, the cost, and the source.",
    icon: ShieldCheck,
    label: "IMPACT REPORT",
    value: "2 orders affected",
    status: "$2,400 estimated exposure",
  },
  {
    n: "03",
    title: "Make your move.",
    description: "Review the action. You stay in control.",
    icon: Send,
    label: "SUPPLIER REQUEST",
    value: "One clear next step",
    status: "Awaiting your approval",
  },
];
export default function Landing({ section = "" }: { section?: string }) {
  const page = useRef<HTMLDivElement>(null);
  const photo = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(() => {
    try {
      const d = JSON.parse(localStorage.getItem("em-inquiry") || "null");
      return d &&
        typeof d.name === "string" &&
        typeof d.email === "string" &&
        typeof d.message === "string"
        ? d
        : { name: "", email: "", message: "" };
    } catch {
      return { name: "", email: "", message: "" };
    }
  });
  useEffect(() => {
    document.body.classList.add("landing-body");
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    const update = () => {
      frame = 0;
      if (!page.current) return;
      page.current
        .querySelectorAll<HTMLElement>("[data-parallax]")
        .forEach((el) => {
          const rect = el.getBoundingClientRect();
          const offset = motion.matches
            ? 0
            : Math.max(
                -1,
                Math.min(
                  1,
                  (innerHeight / 2 - (rect.top + rect.height / 2)) /
                    innerHeight,
                ),
              );
          el.style.setProperty("--scroll", `${offset * 70}px`);
          el.style.setProperty("--scroll-turn", `${offset * 9}deg`);
        });
    };
    const scroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    scroll();
    window.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("resize", scroll);
    motion.addEventListener("change", scroll);
    return () => {
      document.body.classList.remove("landing-body");
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scroll);
      window.removeEventListener("resize", scroll);
      motion.removeEventListener("change", scroll);
    };
  }, []);
  useEffect(() => {
    if (section && ["how", "about", "contact"].includes(section)) {
      requestAnimationFrame(() =>
        document.getElementById(section)?.scrollIntoView({
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "instant"
            : "smooth",
          block: "start",
        }),
      );
    }
  }, [section]);
  const link = (name: string, id: string) => (
    <a
      className="lp-nav-link"
      href={"#/?section=" + id}
      onClick={() => {
        if (section === id)
          document.getElementById(id)?.scrollIntoView({
            behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
              ? "instant"
              : "smooth",
          });
      }}
    >
      <span>{name}</span>
    </a>
  );
  const movePhoto = (e: React.PointerEvent<HTMLDivElement>) => {
    if (
      matchMedia("(prefers-reduced-motion: reduce)").matches ||
      e.pointerType === "touch"
    )
      return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5,
      y = (e.clientY - r.top) / r.height - 0.5;
    e.currentTarget.style.setProperty("--tilt-x", `${-y * 3}deg`);
    e.currentTarget.style.setProperty("--tilt-y", `${x * 2}deg`);
    e.currentTarget.style.setProperty("--pan-x", `${x * -9}px`);
    e.currentTarget.style.setProperty("--pan-y", `${y * -6}px`);
  };
  const reset = () => {
    ["--tilt-x", "--tilt-y", "--pan-x", "--pan-y"].forEach((v) =>
      photo.current?.style.removeProperty(v),
    );
  };
  const ActiveIcon = steps[step].icon;
  return (
    <div className="landing-stage" ref={page}>
      <a
        href="#landing-content"
        className="lp-skip"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("landing-content")?.focus();
        }}
      >
        Skip to content
      </a>
      <div className="landing-paper">
        <header className="lp-header">
          <a className="lp-wordmark" href="#/">
            ExportMate<span>®</span>
          </a>
          <nav aria-label="Main navigation">
            {link("How it works", "how")}
            {link("About us", "about")}
            {link("Get in touch", "contact")}
          </nav>
          <a className="lp-login" href="#/login">
            Log in
            <ArrowUpRight size={17} />
          </a>
        </header>
        <main className="lp-main" id="landing-content" tabIndex={-1}>
          <div className="lp-heading-area">
            <h1 className="lp-headline">
              <span className="lp-line-one">
                <span>MOVING TRADE</span>
              </span>
              <span className="lp-line-two">
                <strong>FORWARD</strong>
              </span>
            </h1>
            <div className="lp-intro">
              <p className="lp-description">
                Trade changes.
                <br />
                Clear next steps.
              </p>
              <button className="lp-cta" onClick={openDemo}>
                <span>Explore demo</span>
                <span className="lp-arrow">
                  <ArrowRight />
                </span>
              </button>
            </div>
          </div>
          {/* In the flow below the headline: the intro beside it is pinned to its bottom. */}
          <p className="lp-explainer">
            ExportMate checks your export orders against changing trade rules
            and flags the shipments that need documents.
          </p>
          <div className="lp-photo-wrap">
            <div
              className="lp-photo"
              ref={photo}
              onPointerMove={movePhoto}
              onPointerLeave={reset}
            >
              <img
                src="/trade-desk.png"
                alt="Archival-style shipping desk with vintage CRT monitors"
                fetchPriority="high"
              />
              <div className="lp-photo-grain" aria-hidden="true" />
              <div className="lp-photo-caption">
                <span>A NEW PERSPECTIVE ON TRADE.</span>
                <span>EXPORTMATE / 2026</span>
              </div>
            </div>
          </div>
        </main>
        <div className="lp-footer">
          <div className="lp-footer-statement">
            <strong>LOCAL ROOTS.</strong>
            <span>GLOBAL REACH.</span>
          </div>
          <p>
            Built for the people
            <br />
            behind the shipment.
          </p>
          <div className="lp-globe-wrap">
            <Suspense
              fallback={<span className="lp-globe-placeholder">◎</span>}
            >
              <TradeGlobe />
            </Suspense>
            <span className="lp-globe-hint">GIVE IT A SPIN ↗</span>
          </div>
        </div>
      </div>
      <div className="lp-scroll-cue">
        <span>THERE’S MORE BELOW</span>
        <ArrowDown size={15} />
        <span>SCROLL TO EXPLORE</span>
      </div>
      <section
        className="story-how story-section"
        id="how"
        aria-labelledby="how-title"
      >
        <div className="story-section-top">
          <span>01 / HOW IT WORKS</span>
          <span>FROM SOURCE TO SHIPMENT</span>
        </div>
        <div className="how-layout">
          <div className="how-visual" data-parallax>
            <img
              src="/port.jpg"
              alt="Cargo containers and cranes in a working port"
              loading="lazy"
            />
            <div className="how-photo-shade" />
            <span className="story-image-index">FIELD NOTES / 001</span>
            <div className="document-scene">
              <div className="document-back back-two" />
              <div className="document-back back-one" />
              <div className="document-front" key={step}>
                <div className="document-top">
                  <span>EXPORTMATE</span>
                  <FileText size={16} />
                </div>
                <span className="document-kicker">{steps[step].label}</span>
                <ActiveIcon
                  className="document-icon"
                  size={32}
                  strokeWidth={1}
                />
                <strong>{steps[step].value}</strong>
                <div className="document-lines">
                  <i />
                  <i />
                  <i />
                </div>
                <span className="document-status">
                  <span />
                  {steps[step].status}
                </span>
                <div className="document-bottom">
                  <span>VN → SG → EU</span>
                  <span>0{step + 1} / 03</span>
                </div>
              </div>
            </div>
            <span className="how-caption">
              SAMPLE WORKFLOW · YOUR DATA, CONNECTED
            </span>
          </div>
          <div className="how-copy">
            <h2 id="how-title">
              Three steps.
              <br />
              <strong>One clear view.</strong>
            </h2>
            <div
              className="how-steps"
              role="tablist"
              aria-label="Workflow steps"
            >
              {steps.map((s, i) => (
                <button
                  role="tab"
                  aria-selected={step === i}
                  tabIndex={step === i ? 0 : -1}
                  aria-controls="workflow-summary"
                  id={"workflow-step-" + i}
                  key={s.n}
                  className={step === i ? "active" : ""}
                  onClick={() => setStep(i)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "ArrowDown" ||
                      e.key === "ArrowRight" ||
                      e.key === "ArrowUp" ||
                      e.key === "ArrowLeft"
                    ) {
                      e.preventDefault();
                      const next =
                        (i +
                          (e.key === "ArrowDown" || e.key === "ArrowRight"
                            ? 1
                            : 2)) %
                        3;
                      setStep(next);
                      document.getElementById("workflow-step-" + next)?.focus();
                    }
                  }}
                >
                  <span>{s.n}</span>
                  <div>
                    <h3>{s.title}</h3>
                    <p>{s.description}</p>
                  </div>
                  <ArrowUpRight size={19} />
                </button>
              ))}
            </div>
            <p
              id="workflow-summary"
              role="tabpanel"
              aria-labelledby={"workflow-step-" + step}
              className="workflow-summary"
            >
              {steps[step].status}
            </p>
            <button className="story-link" onClick={openDemo}>
              See it in action
              <ArrowRight size={21} />
            </button>
          </div>
        </div>
      </section>
      <section
        className="story-about story-section"
        id="about"
        aria-labelledby="about-title"
      >
        <div className="story-section-top">
          <span>02 / ABOUT US</span>
          <span>BUILT AROUND THE MAKER</span>
        </div>
        <div className="about-layout">
          <div className="about-copy">
            <span className="about-overline">THE WORLD STARTS SOMEWHERE.</span>
            <h2 id="about-title">
              Small factories.
              <br />
              <strong>Big horizons.</strong>
            </h2>
            <p>
              Trade intelligence for the people
              <br />
              who make things happen.
            </p>
            <div className="about-rule" />
            <div className="about-footnote">
              <span>OUR FIRST CORRIDOR</span>
              <strong>
                Vietnam <ArrowRight size={20} /> Singapore{" "}
                <ArrowRight size={20} /> Europe
              </strong>
            </div>
            <a className="story-link" href="#/signup">
              Build with us
              <ArrowUpRight size={21} />
            </a>
          </div>
          <div className="about-visual" data-parallax>
            <div className="about-photo">
              <img
                src="/workshop.png"
                alt="A craftsperson measuring plywood in a sunlit woodworking factory"
                loading="lazy"
              />
            </div>
            <div className="maker-label">
              <span>HANDLE WITH PERSPECTIVE.</span>
              <strong>
                MADE HERE.
                <br />
                GOING PLACES.
              </strong>
              <div>
                <span>ORIGIN / VIETNAM</span>
                <span>↗</span>
              </div>
              <div className="label-barcode" />
            </div>
            <span className="about-photo-caption">
              THE PEOPLE BEHIND THE PRODUCT.
            </span>
          </div>
        </div>
        <div className="about-marquee" aria-hidden="true">
          <span>LOCAL KNOWLEDGE.</span>
          <strong>GLOBAL POSSIBILITIES.</strong>
          <span>LOCAL KNOWLEDGE.</span>
        </div>
      </section>
      <section
        className="story-contact story-section"
        id="contact"
        aria-labelledby="contact-title"
      >
        <div className="story-section-top">
          <span>03 / GET IN TOUCH</span>
          <span>THE NEXT CHAPTER STARTS HERE</span>
        </div>
        <div className="contact-layout">
          <div className="contact-visual" data-parallax>
            <img
              src="/contact-desk.png"
              alt="A cream vintage telephone beside a maritime chart on a green desk"
              loading="lazy"
            />
            <div className="contact-stamp">
              <span>OPEN LINES.</span>
              <strong>
                NEW
                <br />
                POSSIBILITIES.
              </strong>
              <span>EXPORTMATE / 2026</span>
            </div>
            <div className="contact-postmark">
              LET’S TALK <ArrowUpRight size={30} />
            </div>
          </div>
          <div className="contact-copy">
            <h2 id="contact-title">
              Your next
              <br />
              <strong>conversation.</strong>
            </h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                try {
                  localStorage.setItem("em-inquiry", JSON.stringify(draft));
                  setSaved(true);
                  setError("");
                } catch {
                  setError(
                    "Browser storage is unavailable. Your draft was not saved.",
                  );
                }
              }}
            >
              <div className="contact-fields">
                <label>
                  Name
                  <input
                    required
                    value={draft.name}
                    onChange={(e) => {
                      setDraft({ ...draft, name: e.target.value });
                      setSaved(false);
                    }}
                    placeholder="Your name"
                  />
                </label>
                <label>
                  Work email
                  <input
                    required
                    type="email"
                    value={draft.email}
                    onChange={(e) => {
                      setDraft({ ...draft, email: e.target.value });
                      setSaved(false);
                    }}
                    placeholder="you@company.com"
                  />
                </label>
              </div>
              <label>
                What are you working on?
                <textarea
                  required
                  rows={3}
                  maxLength={2000}
                  value={draft.message}
                  onChange={(e) => {
                    setDraft({ ...draft, message: e.target.value });
                    setSaved(false);
                  }}
                  placeholder="A little about your business…"
                />
              </label>
              <button type="submit" className="contact-submit">
                {saved ? "Draft saved" : "Save inquiry draft"}
                {saved ? <Check size={20} /> : <ArrowUpRight size={20} />}
              </button>
              <div className="contact-status" role="status">
                {error ||
                  (saved
                    ? "Saved in this browser. Not sent."
                    : "Demo form · saved locally, not sent.")}
              </div>
              {(saved || draft.message) && (
                <button
                  type="button"
                  className="contact-clear"
                  onClick={() => {
                    try {
                      localStorage.removeItem("em-inquiry");
                      setDraft({ name: "", email: "", message: "" });
                      setSaved(false);
                      setError("");
                    } catch {
                      setError("Could not clear the draft.");
                    }
                  }}
                >
                  Clear draft
                </button>
              )}
            </form>
          </div>
        </div>
      </section>
      <footer className="site-bottom">
        <a className="lp-wordmark" href="#/">
          ExportMate<span>®</span>
        </a>
        <div>
          <a href="#/login">Log in</a>
          <a href="#/signup">Create account</a>
          <a href="#/privacy">Privacy</a>
          <a href="#/terms">Terms</a>
        </div>
        <span>© 2026 EXPORTMATE</span>
      </footer>
    </div>
  );
}
