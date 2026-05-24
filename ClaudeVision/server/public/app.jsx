const { useState, useEffect, useRef } = React;

const DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#FF7A33",
  "palette": "graphite",
  "heroLayout": "split",
  "loginStyle": "filled",
  "showSpecs": true,
  "displayFont": "Instrument Serif",
  "headline": "A voice in your ear,\nwith a sharper mind."
}/*EDITMODE-END*/;

const PALETTES = {
  cream:  { bg: "#F4EFE5", ink: "#1A1714", muted: "#7B7468", line: "#D9D1C0", panel: "#EBE4D4" },
  paper:  { bg: "#F6F6F4", ink: "#161616", muted: "#6F6F6B", line: "#DEDED8", panel: "#ECECE6" },
  graphite: { bg: "#13141A", ink: "#F2EFE8", muted: "#8A8A92", line: "#2A2C36", panel: "#1B1D26" },
  storm:  { bg: "#1F2A30", ink: "#EFE9DA", muted: "#92A0A6", line: "#34434B", panel: "#27343A" }
};

// ───────────────────────────────────────────────────────────────
// Inline icon components (simple geometry only)
// ───────────────────────────────────────────────────────────────
// Mark: concentric sound rings emanating from a point — voice-first today,
// reads as an aperture/iris when vision arrives later.
const Aperture = ({ size = 14, color = "currentColor" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.2">
    <circle cx="12" cy="12" r="1.6" fill={color} stroke="none" />
    <circle cx="12" cy="12" r="5.2" />
    <circle cx="12" cy="12" r="8.6" opacity="0.65" />
    <circle cx="12" cy="12" r="11.4" opacity="0.35" />
  </svg>
);

const Dot = ({ color }) => (
  <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 999, background: color, boxShadow: `0 0 0 3px ${color}22` }} />
);

// ───────────────────────────────────────────────────────────────
// Glasses placeholder — abstract geometric, not Meta-branded
// ───────────────────────────────────────────────────────────────
const GlassesViz = ({ accent, ink, line, panel }) => (
  <svg viewBox="0 0 600 320" style={{ width: "100%", height: "auto", display: "block" }}>
    {/* bg stripes placeholder texture */}
    <defs>
      <pattern id="stripes" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" stroke={line} strokeWidth="1" />
      </pattern>
      <radialGradient id="lensGlow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor={accent} stopOpacity="0.65" />
        <stop offset="55%" stopColor={accent} stopOpacity="0.15" />
        <stop offset="100%" stopColor={accent} stopOpacity="0" />
      </radialGradient>
    </defs>
    <rect x="0" y="0" width="600" height="320" fill="url(#stripes)" opacity="0.4" />
    {/* frame */}
    <g stroke={ink} strokeWidth="2" fill="none">
      {/* bridge + temples */}
      <path d="M 80 160 L 200 160 Q 220 150 240 160 L 360 160 Q 380 150 400 160 L 520 160" />
      <path d="M 70 158 Q 50 158 40 170" />
      <path d="M 530 158 Q 550 158 560 170" />
      {/* left lens */}
      <rect x="100" y="120" width="160" height="100" rx="22" fill={panel} />
      {/* right lens */}
      <rect x="340" y="120" width="160" height="100" rx="22" fill={panel} />
    </g>
    {/* lens glow */}
    <ellipse cx="180" cy="170" rx="70" ry="42" fill="url(#lensGlow)" />
    <ellipse cx="420" cy="170" rx="70" ry="42" fill="url(#lensGlow)" />
    {/* HUD ticks */}
    <g stroke={ink} strokeWidth="1" opacity="0.55">
      <line x1="180" y1="135" x2="180" y2="143" />
      <line x1="420" y1="135" x2="420" y2="143" />
      <line x1="180" y1="197" x2="180" y2="205" />
      <line x1="420" y1="197" x2="420" y2="205" />
    </g>
    {/* aperture marks on the lenses */}
    <g stroke={accent} strokeWidth="1.4" fill="none">
      <circle cx="180" cy="170" r="14" />
      <circle cx="180" cy="170" r="5" />
      <circle cx="420" cy="170" r="14" />
      <circle cx="420" cy="170" r="5" />
    </g>
    {/* corner crops */}
    <g stroke={ink} strokeWidth="1" opacity="0.5">
      <path d="M 20 20 L 32 20 M 20 20 L 20 32" />
      <path d="M 580 20 L 568 20 M 580 20 L 580 32" />
      <path d="M 20 300 L 32 300 M 20 300 L 20 288" />
      <path d="M 580 300 L 568 300 M 580 300 L 580 288" />
    </g>
    {/* monospace label */}
    <text x="20" y="312" fontFamily="ui-monospace, monospace" fontSize="10" fill={ink} opacity="0.5">
      ASIDE · FRAME RENDER · 600×320
    </text>
  </svg>
);

// ───────────────────────────────────────────────────────────────
// Top nav
// ───────────────────────────────────────────────────────────────
const Nav = ({ p, accent, loginStyle, onLogin }) => (
  <header style={{
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "22px 48px", borderBottom: `1px solid ${p.line}`,
    position: "sticky", top: 0, background: `${p.bg}f0`, backdropFilter: "blur(8px)",
    zIndex: 10
  }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Aperture size={22} color={p.ink} />
      <span style={{ fontFamily: "'Inter Tight', sans-serif", fontWeight: 600, letterSpacing: "-0.01em", fontSize: 18, color: p.ink }}>
        Aside
      </span>
      <span style={{
        fontFamily: "ui-monospace, monospace", fontSize: 10, color: p.muted,
        border: `1px solid ${p.line}`, padding: "2px 6px", borderRadius: 3, marginLeft: 6, textTransform: "uppercase", letterSpacing: "0.08em"
      }}>
        Beta · v0.4
      </span>
    </div>
    <nav className="nav-links" style={{ display: "flex", alignItems: "center", gap: 28, fontFamily: "'Inter Tight', sans-serif", fontSize: 14, color: p.ink }}>
      <a href="#capabilities" style={{ color: p.ink, textDecoration: "none" }}>Capabilities</a>
      <a href="#how" style={{ color: p.ink, textDecoration: "none" }}>How it works</a>
      <a href="#specs" style={{ color: p.ink, textDecoration: "none" }}>Compatibility</a>
      <LoginButton variant={loginStyle} accent={accent} p={p} onClick={onLogin} compact />
    </nav>
    <div className="nav-login" style={{ display: "none" }}>
      <LoginButton variant={loginStyle} accent={accent} p={p} onClick={onLogin} compact />
    </div>
  </header>
);

// ───────────────────────────────────────────────────────────────
// Login button — three variants
// ───────────────────────────────────────────────────────────────
const LoginButton = ({ variant, accent, p, onClick, compact = false, large = false }) => {
  const [hover, setHover] = useState(false);
  const base = {
    fontFamily: "'Inter Tight', sans-serif",
    fontSize: large ? 16 : 14,
    fontWeight: 500,
    letterSpacing: "-0.005em",
    padding: large ? "16px 28px" : (compact ? "9px 18px" : "12px 22px"),
    borderRadius: 999,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    transition: "transform 180ms ease, background 180ms ease, box-shadow 180ms ease, color 180ms ease",
    transform: hover ? "translateY(-1px)" : "translateY(0)",
    border: "none",
    whiteSpace: "nowrap"
  };

  if (variant === "ghost") {
    return (
      <button
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onClick={onClick}
        style={{ ...base, background: "transparent", color: p.ink, border: `1px solid ${p.ink}`, boxShadow: hover ? `0 0 0 4px ${accent}33` : "none" }}>
        <Dot color={accent} /> Log in with Aside
      </button>
    );
  }

  if (variant === "lens") {
    return (
      <button
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onClick={onClick}
        style={{
          ...base,
          background: p.ink, color: p.bg,
          border: `1px solid ${p.ink}`,
          padding: large ? "0 28px 0 0" : (compact ? "0 18px 0 0" : "0 22px 0 0"),
          height: large ? 56 : (compact ? 40 : 46),
          boxShadow: hover ? `0 8px 24px -10px ${p.ink}88` : "none"
        }}>
        <span style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: large ? 56 : (compact ? 40 : 46),
          height: large ? 56 : (compact ? 40 : 46),
          borderRadius: 999, background: accent, color: p.ink, marginRight: 10
        }}>
          <Aperture size={large ? 22 : 18} color={p.ink} />
        </span>
        Sign in
      </button>
    );
  }

  // filled (default)
  return (
    <button
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onClick={onClick}
      style={{
        ...base,
        background: accent, color: p.ink,
        boxShadow: hover ? `0 10px 30px -12px ${accent}` : `0 6px 18px -10px ${accent}`,
      }}>
      <Aperture size={large ? 18 : 14} color={p.ink} />
      Log in
    </button>
  );
};

// ───────────────────────────────────────────────────────────────
// Hero
// ───────────────────────────────────────────────────────────────
const Hero = ({ p, accent, layout, headline, loginStyle, onLogin }) => {
  const lines = headline.split("\n");
  return (
    <section className="hero-section" style={{
      padding: layout === "centered" ? "96px 48px 80px" : "80px 48px",
      maxWidth: 1440, margin: "0 auto"
    }}>
      <div className={`hero-grid ${layout === "centered" ? "centered" : ""}`}>
      <div style={{ textAlign: layout === "centered" ? "center" : "left", maxWidth: layout === "centered" ? 860 : "none", margin: layout === "centered" ? "0 auto" : 0 }}>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 10,
          fontFamily: "ui-monospace, monospace", fontSize: 11, color: p.muted,
          padding: "6px 12px", border: `1px solid ${p.line}`, borderRadius: 999,
          textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 28
        }}>
          <Dot color={accent} /> Now in invite-only preview
        </div>
        <h1 className="hero-h1" style={{ color: p.ink }}>
          {lines.map((l, i) => (
            <span key={i} style={{ display: "block", fontStyle: i === 1 ? "italic" : "normal" }}>
              {l}
            </span>
          ))}
        </h1>
        <p style={{
          fontFamily: "'Inter Tight', sans-serif",
          fontSize: 19, lineHeight: 1.5, color: p.muted, maxWidth: 560,
          margin: layout === "centered" ? "0 auto 36px" : "0 0 36px",
          textWrap: "pretty"
        }}>
          Aside is a voice channel for smart glasses, powered by a modern reasoning model. Speak, listen, translate, remember — hands-free, eyes-up. <span style={{ color: p.ink }}>Lens vision is rolling out soon.</span>
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 14, justifyContent: layout === "centered" ? "center" : "flex-start", flexWrap: "wrap" }}>
          <LoginButton variant={loginStyle} accent={accent} p={p} onClick={onLogin} large />
        </div>
        <div className="hero-meta" style={{ marginTop: 56, display: "flex", gap: 36, color: p.muted, fontFamily: "ui-monospace, monospace", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", flexWrap: "wrap", justifyContent: layout === "centered" ? "center" : "flex-start" }}>
          <span>Voice latency · 240 ms median</span>
          <span>Privacy · on-device wake</span>
          <span>Languages · 38</span>
          <span style={{ color: p.ink }}>Vision · coming soon</span>
        </div>
      </div>

      {layout === "split" && (
        <div className="hero-visual-wrap" style={{ position: "relative" }}>
          <div className="hero-visual" style={{
            background: p.panel, borderRadius: 18, padding: 28, border: `1px solid ${p.line}`,
            position: "relative", overflow: "hidden"
          }}>
            <div style={{
              position: "absolute", inset: 0,
              background: `radial-gradient(circle at 30% 30%, ${accent}22, transparent 55%)`,
              animation: "floatY 7s ease-in-out infinite", pointerEvents: "none"
            }} />
            <GlassesViz accent={accent} ink={p.ink} line={p.line} panel={p.bg} />
            <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
              <LiveCaptureCard accent={accent} ink={p.ink} muted={p.muted} line={p.line} bg={p.bg} panel={p.panel} />
            </div>
          </div>
          <FloatingCallout p={p} accent={accent} />
        </div>
      )}
      </div>
    </section>
  );
};

const FloatingCallout = ({ p, accent }) => (
  <div className="floating-callout" style={{
    position: "absolute", bottom: -28, left: -32,
    background: p.bg, border: `1px solid ${p.line}`,
    padding: "14px 18px", borderRadius: 12, maxWidth: 280,
    fontFamily: "'Inter Tight', sans-serif", fontSize: 13, color: p.ink,
    boxShadow: `0 24px 60px -30px ${p.ink}66`
  }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
      <Dot color={accent} />
      <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 10, color: p.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>Live capture · 04:21 pm</span>
    </div>
    <div style={{ lineHeight: 1.4 }}>
      “The bakery you asked about closes in nine minutes. It’s two blocks east — want me to navigate?”
    </div>
  </div>
);

// ───────────────────────────────────────────────────────────────
// Animated flow section
// ───────────────────────────────────────────────────────────────
const FlowSection = ({ p, accent }) => (
  <section style={{
    padding: "100px 48px",
    background: p.panel,
    borderTop: `1px solid ${p.line}`,
    borderBottom: `1px solid ${p.line}`,
    position: "relative", overflow: "hidden"
  }}>
    <div style={{
      position: "absolute", inset: 0,
      background: `radial-gradient(ellipse at 50% 30%, ${accent}1a, transparent 60%)`,
      pointerEvents: "none"
    }} />
    <div style={{ maxWidth: 1280, margin: "0 auto", position: "relative" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 36, gap: 24, flexWrap: "wrap" }}>
        <div>
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: p.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>§ Live data flow</span>
          <h2 className="shimmer-text flow-headline" style={{
            fontFamily: "var(--display-font)", fontSize: "clamp(36px, 4.2vw, 60px)", fontWeight: 400,
            letterSpacing: "-0.02em", color: p.ink, margin: "14px 0 0", textWrap: "balance",
            "--accent": accent
          }}>
            Voice in, voice out, <em>in a quarter second.</em>
          </h2>
        </div>
        <div style={{ display: "flex", gap: 16, fontFamily: "ui-monospace, monospace", fontSize: 11, color: p.muted, letterSpacing: "0.08em", textTransform: "uppercase", flexShrink: 0 }}>
          <span><Dot color={accent} /> &nbsp; Capture</span>
          <span><Dot color={accent} /> &nbsp; Reason</span>
          <span><Dot color={accent} /> &nbsp; Reply</span>
        </div>
      </div>
      <DataFlow accent={accent} ink={p.ink} line={p.line} muted={p.muted} panel={p.bg} bg={p.panel} />
      <div style={{
        marginTop: 28, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: 0, border: `1px solid ${p.line}`, background: p.bg
      }}>
        {[
          { k: "01", t: "Voice packet", v: "~28 KB", n: "Per inference cycle" },
          { k: "02", t: "Round-trip", v: "240 ms", n: "P50, US-east region" },
          { k: "03", t: "On-device wake", v: "100 %", n: "No cloud till activation" },
          { k: "04", t: "Languages", v: "38", n: "Live voice + reply" }
        ].map((m, i, arr) => (
          <div key={i} style={{ padding: "22px 22px", borderRight: i < arr.length - 1 ? `1px solid ${p.line}` : "none" }}>
            <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 10, color: p.muted, letterSpacing: "0.1em" }}>{m.k}</div>
            <div style={{ fontFamily: "var(--display-font)", fontSize: 38, color: p.ink, marginTop: 4, lineHeight: 1, letterSpacing: "-0.02em" }}>{m.v}</div>
            <div style={{ fontFamily: "'Inter Tight', sans-serif", fontSize: 14, color: p.ink, fontWeight: 500, marginTop: 8 }}>{m.t}</div>
            <div style={{ fontFamily: "'Inter Tight', sans-serif", fontSize: 12, color: p.muted, marginTop: 2 }}>{m.n}</div>
          </div>
        ))}
      </div>
    </div>
  </section>
);

// ───────────────────────────────────────────────────────────────
// Capabilities
// ───────────────────────────────────────────────────────────────
const CAPABILITIES = [
  { tag: "01", title: "Talk, don’t tap", body: "Ask anything in plain speech — directions, definitions, a quick draft of an email. Claude answers through your glasses’ speakers in under a second." },
  { tag: "02", title: "Ambient memory", body: "Opt-in recall of moments, names, and places you mention. Ask ‘where did I park?’ or ‘what was that podcast?’ and get an answer, not a search." },
  { tag: "03", title: "Whisper-quiet input", body: "Sub-vocal commands and bone-conduction reply. Useful in libraries, meetings, and the cereal aisle alike." },
  { tag: "04", title: "Tool-using in the wild", body: "Translate live, transcribe, draft, schedule — Claude calls the right tool without you naming it. All from voice.", coming: false },
  { tag: "05", title: "Live lens vision", body: "Point your gaze at a menu, sign, or circuit board and Claude will reason over the frame. Rolling out to early-access waves this summer.", coming: true }
];

const Capabilities = ({ p, accent }) => (
  <section id="capabilities" style={{ padding: "100px 48px", borderTop: `1px solid ${p.line}`, borderBottom: `1px solid ${p.line}` }}>
    <div style={{ maxWidth: 1440, margin: "0 auto" }}>
      <div className="section-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 56, gap: 32, flexWrap: "wrap" }}>
        <h2 style={{
          fontFamily: "var(--display-font)", fontSize: "clamp(36px, 4vw, 56px)", fontWeight: 400, letterSpacing: "-0.02em",
          color: p.ink, margin: 0, maxWidth: 720, textWrap: "balance"
        }}>
          A model that <em>listens, thinks, replies</em> — hands-free.
        </h2>
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: p.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>§ Capabilities</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 0, borderTop: `1px solid ${p.line}` }}>
        {CAPABILITIES.map((c, i) => (
          <div key={i} className="capability-cell" style={{
            padding: "32px 28px 36px",
            borderRight: i < CAPABILITIES.length - 1 ? `1px solid ${p.line}` : "none",
            borderBottom: `1px solid ${p.line}`,
            background: i === 1 ? `${accent}14` : "transparent",
            position: "relative",
            opacity: c.coming ? 0.85 : 1
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, color: p.muted, fontFamily: "ui-monospace, monospace", fontSize: 11, letterSpacing: "0.1em" }}>
              <span>{c.tag}</span>
              <span style={{ flex: 1, height: 1, background: p.line }} />
              {c.coming && (
                <span style={{
                  fontFamily: "ui-monospace, monospace", fontSize: 9, color: p.ink,
                  border: `1px solid ${p.ink}`, padding: "2px 6px", borderRadius: 3,
                  letterSpacing: "0.12em"
                }}>SOON</span>
              )}
            </div>
            <h3 style={{ fontFamily: "var(--display-font)", fontSize: 26, fontWeight: 400, color: p.ink, margin: "0 0 12px", letterSpacing: "-0.01em" }}>
              {c.title}
            </h3>
            <p style={{ fontFamily: "'Inter Tight', sans-serif", fontSize: 14.5, lineHeight: 1.55, color: p.muted, margin: 0, textWrap: "pretty" }}>
              {c.body}
            </p>
          </div>
        ))}
      </div>
    </div>
  </section>
);

// ───────────────────────────────────────────────────────────────
// How it works
// ───────────────────────────────────────────────────────────────
const HowItWorks = ({ p, accent }) => {
  const steps = [
    { n: "I", t: "Wake", d: "A double-tap on the temple or the wake phrase 'Hey Aside' begins the session." },
    { n: "II", t: "Reason", d: "Your voice is streamed to the model over an encrypted session and answered in real time." },
    { n: "III", t: "Reply", d: "Answer arrives as whisper audio in your ear, or as a hand-off to your phone." }
  ];
  return (
    <section id="how" style={{ padding: "100px 48px", maxWidth: 1440, margin: "0 auto" }}>
      <div className="how-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 80, alignItems: "start" }}>
        <div>
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: p.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>§ How it works</span>
          <h2 style={{ fontFamily: "var(--display-font)", fontSize: "clamp(36px, 4vw, 56px)", fontWeight: 400, letterSpacing: "-0.02em", color: p.ink, margin: "16px 0 24px", textWrap: "balance" }}>
            Three motions. <em>That's the whole loop.</em>
          </h2>
          <p style={{ fontFamily: "'Inter Tight', sans-serif", fontSize: 16, color: p.muted, lineHeight: 1.55, maxWidth: 360, textWrap: "pretty" }}>
            No app to open, no menu to thumb through. Designed for the second when curiosity strikes and you still want to be looking at the thing.
          </p>
        </div>
        <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 0 }}>
          {steps.map((s, i) => (
            <li key={i} className="how-step" style={{ display: "grid", gridTemplateColumns: "84px 1fr auto", gap: 24, padding: "28px 0", borderTop: `1px solid ${p.line}`, alignItems: "baseline" }}>
              <span style={{ fontFamily: "var(--display-font)", fontStyle: "italic", fontSize: 32, color: accent }}>{s.n}</span>
              <div>
                <h4 style={{ fontFamily: "'Inter Tight', sans-serif", fontSize: 22, fontWeight: 500, color: p.ink, margin: "0 0 6px", letterSpacing: "-0.01em" }}>{s.t}</h4>
                <p style={{ fontFamily: "'Inter Tight', sans-serif", fontSize: 15, color: p.muted, margin: 0, lineHeight: 1.5, maxWidth: 540, textWrap: "pretty" }}>{s.d}</p>
              </div>
              <span className="step-side" style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: p.muted, letterSpacing: "0.1em" }}>STEP 0{i + 1}</span>
            </li>
          ))}
          <li style={{ borderTop: `1px solid ${p.line}`, height: 1 }}></li>
        </ol>
      </div>
    </section>
  );
};

// ───────────────────────────────────────────────────────────────
// Compatibility / Specs strip
// ───────────────────────────────────────────────────────────────
const Specs = ({ p, accent }) => (
  <section id="specs" style={{ padding: "80px 48px", background: p.panel, borderTop: `1px solid ${p.line}`, borderBottom: `1px solid ${p.line}` }}>
    <div style={{ maxWidth: 1440, margin: "0 auto" }}>
      <div className="section-head" style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 32, gap: 24, flexWrap: "wrap" }}>
        <h2 style={{ fontFamily: "var(--display-font)", fontSize: "clamp(28px, 3vw, 42px)", fontWeight: 400, letterSpacing: "-0.02em", color: p.ink, margin: 0 }}>
          Works with the glasses you already wear.
        </h2>
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: p.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>§ Compatibility matrix</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 0, border: `1px solid ${p.line}`, background: p.bg }}>
        {[
          { name: "Audio-only earwear", status: "Full", note: "Voice in, voice reply" },
          { name: "AR frames with mic", status: "Full", note: "Voice today · camera soon" },
          { name: "Display-only HUDs", status: "Partial", note: "Captions of voice reply" },
          { name: "Phone fallback", status: "Always on", note: "iOS · Android companion app" }
        ].map((row, i, arr) => (
          <div key={i} className="specs-row" style={{ padding: "24px 22px", borderRight: i < arr.length - 1 ? `1px solid ${p.line}` : "none" }}>
            <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 10, letterSpacing: "0.1em", color: p.muted, textTransform: "uppercase", marginBottom: 10 }}>
              <Dot color={row.status === "Partial" ? "#E0A55C" : accent} /> &nbsp; {row.status}
            </div>
            <div style={{ fontFamily: "'Inter Tight', sans-serif", fontSize: 17, color: p.ink, fontWeight: 500, marginBottom: 6 }}>{row.name}</div>
            <div style={{ fontFamily: "'Inter Tight', sans-serif", fontSize: 13, color: p.muted, lineHeight: 1.45 }}>{row.note}</div>
          </div>
        ))}
      </div>
    </div>
  </section>
);

// ───────────────────────────────────────────────────────────────
// Footer CTA + footer
// ───────────────────────────────────────────────────────────────
const FooterCTA = ({ p, accent, loginStyle, onLogin }) => (
  <section className="footer-cta" style={{ padding: "120px 48px", textAlign: "center" }}>
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <Aperture size={36} color={accent} />
      <h2 style={{ fontFamily: "var(--display-font)", fontSize: "clamp(40px, 5vw, 68px)", fontWeight: 400, letterSpacing: "-0.025em", color: p.ink, margin: "20px 0 18px", textWrap: "balance", lineHeight: 1.02 }}>
        Request an invite.<br /><em>Hear differently.</em>
      </h2>
      <p style={{ fontFamily: "'Inter Tight', sans-serif", fontSize: 17, color: p.muted, lineHeight: 1.55, margin: "0 0 36px" }}>
        Aside is opening up in waves through the summer. Sign in to claim your place in the queue.
      </p>
      <div style={{ display: "inline-flex", gap: 14, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
        <LoginButton variant={loginStyle} accent={accent} p={p} onClick={onLogin} large />
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: p.muted, letterSpacing: "0.08em" }}>~14 day wait · 11,402 in queue</span>
      </div>
    </div>
  </section>
);

const Footer = ({ p }) => (
  <footer className="footer-row" style={{ padding: "32px 48px 48px", borderTop: `1px solid ${p.line}`, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 16, fontFamily: "'Inter Tight', sans-serif", fontSize: 12, color: p.muted }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Aperture size={14} color={p.muted} />
      <span>Aside — a quiet companion for your glasses.</span>
    </div>
    <div style={{ display: "flex", gap: 24, fontFamily: "ui-monospace, monospace", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase" }}>
      <span>Privacy</span><span>Terms</span><span>Status</span><span>© 2026</span>
    </div>
  </footer>
);

// ───────────────────────────────────────────────────────────────
// Login modal (interactive)
// ───────────────────────────────────────────────────────────────
const LoginModal = ({ open, onClose, p, accent }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) { setEmail(""); setPassword(""); setError(""); setLoading(false); }
  }, [open]);

  if (!open) return null;

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        window.location.href = "/app";
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data?.error || "Incorrect email or password.");
        setLoading(false);
      }
    } catch {
      setError("Connection error. Try again.");
      setLoading(false);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: `${p.ink}aa`, backdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 24,
      animation: "fadeIn 220ms ease"
    }}>
      <div onClick={e => e.stopPropagation()} className="login-modal" style={{
        background: p.bg, borderRadius: 18, padding: 40, maxWidth: 440, width: "100%",
        border: `1px solid ${p.line}`, position: "relative",
        animation: "popIn 280ms cubic-bezier(.2,.9,.3,1.2)"
      }}>
        <button onClick={onClose} style={{
          position: "absolute", top: 16, right: 16, background: "transparent", border: "none",
          color: p.muted, fontSize: 22, cursor: "pointer", padding: 4, lineHeight: 1
        }}>×</button>
        <Aperture size={28} color={accent} />
        <h3 style={{ fontFamily: "var(--display-font)", fontSize: 32, fontWeight: 400, letterSpacing: "-0.02em", color: p.ink, margin: "16px 0 8px", lineHeight: 1.05 }}>
          Log in to <em>Aside</em>.
        </h3>
        <p style={{ fontFamily: "'Inter Tight', sans-serif", fontSize: 14, color: p.muted, lineHeight: 1.5, margin: "0 0 28px" }}>
          Sign in with your account email and password. New here? You'll need an invite from an admin.
        </p>
        <form onSubmit={submit}>
          <label style={{ fontFamily: "ui-monospace, monospace", fontSize: 10, letterSpacing: "0.1em", color: p.muted, textTransform: "uppercase" }}>
            Email
          </label>
          <input
            autoFocus type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)}
            style={{
              width: "100%", marginTop: 6, marginBottom: 14, padding: "14px 16px", borderRadius: 10,
              border: `1px solid ${error ? "#e05" : p.line}`, background: p.panel, color: p.ink,
              fontFamily: "'Inter Tight', sans-serif", fontSize: 16, outline: "none", boxSizing: "border-box"
            }} />
          <label style={{ fontFamily: "ui-monospace, monospace", fontSize: 10, letterSpacing: "0.1em", color: p.muted, textTransform: "uppercase" }}>
            Password
          </label>
          <input
            type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)}
            style={{
              width: "100%", marginTop: 6, padding: "14px 16px", borderRadius: 10,
              border: `1px solid ${error ? "#e05" : p.line}`, background: p.panel, color: p.ink,
              fontFamily: "'Inter Tight', sans-serif", fontSize: 16, outline: "none", boxSizing: "border-box"
            }} />
          {error && <p style={{ fontFamily: "'Inter Tight', sans-serif", fontSize: 13, color: "#e05", margin: "8px 0 0" }}>{error}</p>}
          <button type="submit" disabled={loading || !email || !password} style={{
            marginTop: 16, width: "100%", padding: "14px", borderRadius: 10, border: "none",
            background: accent, color: p.ink, fontFamily: "'Inter Tight', sans-serif", fontSize: 15, fontWeight: 500,
            cursor: loading ? "wait" : "pointer", opacity: (!email || !password) ? 0.5 : 1
          }}>
            {loading ? "Checking…" : "Log in →"}
          </button>
        </form>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────
// Tweaks
// ───────────────────────────────────────────────────────────────
const Tweaks = ({ t, setTweak }) => (
  <TweaksPanel title="Tweaks">
    <TweakSection title="Visual">
      <TweakColor
        label="Accent"
        value={t.accent}
        onChange={v => setTweak("accent", v)}
        options={["#FF7A33", "#FFB85C", "#6FE3A8", "#9DB8FF", "#E89BE3"]} />
      <TweakRadio
        label="Palette"
        value={t.palette}
        onChange={v => setTweak("palette", v)}
        options={[
          { value: "cream", label: "Cream" },
          { value: "paper", label: "Paper" },
          { value: "graphite", label: "Graphite" },
          { value: "storm", label: "Storm" }
        ]} />
      <TweakSelect
        label="Display font"
        value={t.displayFont}
        onChange={v => setTweak("displayFont", v)}
        options={[
          { value: "Instrument Serif", label: "Instrument Serif" },
          { value: "Fraunces", label: "Fraunces" },
          { value: "Inter Tight", label: "Inter Tight (sans)" },
          { value: "Newsreader", label: "Newsreader" }
        ]} />
    </TweakSection>
    <TweakSection title="Layout">
      <TweakRadio
        label="Hero layout"
        value={t.heroLayout}
        onChange={v => setTweak("heroLayout", v)}
        options={[
          { value: "split", label: "Split" },
          { value: "centered", label: "Centered" }
        ]} />
      <TweakToggle
        label="Show compatibility section"
        value={t.showSpecs}
        onChange={v => setTweak("showSpecs", v)} />
    </TweakSection>
    <TweakSection title="Login button">
      <TweakRadio
        label="Style"
        value={t.loginStyle}
        onChange={v => setTweak("loginStyle", v)}
        options={[
          { value: "filled", label: "Filled" },
          { value: "ghost", label: "Ghost" },
          { value: "lens", label: "Lens" }
        ]} />
    </TweakSection>
    <TweakSection title="Copy">
      <TweakText
        label="Headline (use \\n for line break)"
        value={t.headline.replace(/\n/g, "\\n")}
        onChange={v => setTweak("headline", v.replace(/\\n/g, "\n"))} />
    </TweakSection>
  </TweaksPanel>
);

// ───────────────────────────────────────────────────────────────
// App
// ───────────────────────────────────────────────────────────────
const App = () => {
  const [t, setTweak] = useTweaks(DEFAULTS);
  const [loginOpen, setLoginOpen] = useState(false);
  const p = PALETTES[t.palette] || PALETTES.cream;

  useEffect(() => {
    document.body.style.background = p.bg;
    document.body.style.color = p.ink;
    document.documentElement.style.setProperty("--display-font", `'${t.displayFont}', serif`);
  }, [p, t.displayFont]);

  return (
    <div style={{ background: p.bg, color: p.ink, minHeight: "100vh", fontFamily: "'Inter Tight', sans-serif" }}>
      <Nav p={p} accent={t.accent} loginStyle={t.loginStyle} onLogin={() => setLoginOpen(true)} />
      <Hero p={p} accent={t.accent} layout={t.heroLayout} headline={t.headline} loginStyle={t.loginStyle} onLogin={() => setLoginOpen(true)} />
      <FlowSection p={p} accent={t.accent} />
      <Capabilities p={p} accent={t.accent} />
      <HowItWorks p={p} accent={t.accent} />
      {t.showSpecs && <Specs p={p} accent={t.accent} />}
      <FooterCTA p={p} accent={t.accent} loginStyle={t.loginStyle} onLogin={() => setLoginOpen(true)} />
      <Footer p={p} />
      <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} p={p} accent={t.accent} />
      <Tweaks t={t} setTweak={setTweak} />
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
