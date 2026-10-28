// ─────────────────────────────────────────────────────────────────────────
// Auth screens (Clerk-backed) — sign up, sign in, verify email, phone + SMS OTP,
// 2FA, forgot password, set new password.
// ─────────────────────────────────────────────────────────────────────────
const { useState, useEffect } = React;

// Shared auth header (brand + eyebrow + headline + sub) ──────────────────────
function AuthHead({ eyebrow, eyebrowColor, h, sub, step }) {
  return (
    <div>
      <Wordmark size={17} />
      {step && <div style={{ marginTop: 22 }}><StepBar total={step.total} current={step.current} /><div style={{ marginTop: 7, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", letterSpacing: 1 }}>STEP {step.current + 1} OF {step.total} · {step.label}</div></div>}
      <div style={{ marginTop: step ? 18 : 26 }}>
        <Eyebrow color={eyebrowColor}>{eyebrow}</Eyebrow>
        <h1 style={{ fontWeight: 800, fontSize: 32, lineHeight: 1.0, letterSpacing: -1.5, marginTop: 12, color: "var(--ink)", textWrap: "balance" }}>{h}</h1>
        {sub && <p style={{ marginTop: 11, fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 16, lineHeight: 1.4, color: "var(--ink-2)", textWrap: "pretty" }}>{sub}</p>}
      </div>
    </div>
  );
}

function OrRule({ label = "OR · EMAIL & PASSWORD" }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 13, margin: "20px 0 4px", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", letterSpacing: 1.5 }}>
      <div style={{ flex: 1, height: 1.5, background: "var(--rule-soft)" }} />{label}<div style={{ flex: 1, height: 1.5, background: "var(--rule-soft)" }} />
    </div>
  );
}

// Apple OAuth button with a faithful "SOON" badge (repo ships Apple as coming soon)
function AppleSoonBtn() {
  return (
    <button disabled style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "13px 16px", borderRadius: 11, border: "2px solid var(--rule-soft)", background: "var(--paper-2)", color: "var(--ink-3)", fontFamily: "var(--font-sans)", fontWeight: 700, fontSize: 14.5, cursor: "not-allowed", position: "relative" }}>
      <AppleGlyph color="var(--ink-3)" /> Continue with Apple
      <span style={{ position: "absolute", right: 12, fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 800, letterSpacing: 1, color: "var(--paper)", background: "var(--ink-3)", padding: "2px 6px", borderRadius: 99 }}>SOON</span>
    </button>
  );
}

function TVCredit() {
  return <div style={{ textAlign: "center", marginTop: 16, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)" }}>Charts powered by <span style={{ color: "var(--ink-2)", textDecoration: "underline", textUnderlineOffset: 2 }}>TradingView</span></div>;
}

// ── Sign up ──────────────────────────────────────────────────────────────────
function SignUpScreen({ go, back }) {
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [agree, setAgree] = useState(true);
  const strength = Math.min(4, Math.floor(pw.length / 3));
  return (
    <Screen onBack={back} topPad={60}
      footer={
        <div>
          <PrimaryBtn icon="arrowR" disabled={!agree} onClick={() => go("verify")}>Create account</PrimaryBtn>
          <div style={{ marginTop: 12, textAlign: "center", fontSize: 13, color: "var(--ink-2)" }}>
            Already have an account? <button onClick={() => go("signin")} style={{ border: 0, background: "transparent", color: "var(--emerald-text)", fontWeight: 700, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2, whiteSpace: "nowrap" }}>Sign in</button>
          </div>
        </div>
      }>
      <AuthHead step={{ total: 3, current: 0, label: "ACCOUNT" }}
        eyebrow="CREATE ACCOUNT · 60 SECONDS · NO CARD"
        h={<>Start <span className="ser">free, forever.</span> <span className="hl-gold">No card.</span></>}
        sub="5 free Sage credits a month. PRO is ₹249/mo when you want more." />

      <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 9 }}>
        <OAuthBtn kind="google" onClick={() => go("profile")} />
        <AppleSoonBtn />
      </div>
      <OrRule />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="First name" placeholder="Rahul" value={first} onChange={setFirst} />
        <Field label="Last name" placeholder="Vora" value={last} onChange={setLast} />
      </div>
      <Field label="Email address" type="email" placeholder="you@email.com" value={email} onChange={setEmail} />
      <Field label="Password" hint="8+ chars, mix of types" type="password" placeholder="Make it good" value={pw} onChange={setPw} />
      {pw && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: "flex", gap: 4 }}>
            {[0, 1, 2, 3].map(i => <div key={i} style={{ flex: 1, height: 4, borderRadius: 99, background: i < strength ? (strength >= 3 ? "var(--emerald)" : "var(--pop-2)") : "var(--rule-soft)" }} />)}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 5 }}>{strength >= 3 ? "Strong — nice." : strength === 2 ? "Good — add a symbol for strong." : "Keep going…"}</div>
        </div>
      )}

      <label onClick={() => setAgree(a => !a)} style={{ display: "flex", gap: 9, marginTop: 18, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.45, cursor: "pointer" }}>
        <span style={{ width: 20, height: 20, border: "2px solid var(--ink)", borderRadius: 5, background: agree ? "var(--ink)" : "var(--paper)", display: "grid", placeItems: "center", flexShrink: 0, marginTop: 1 }}>{agree && <Icon name="check" size={12} color="var(--paper)" strokeWidth={3} />}</span>
        <span>I agree to the <span style={{ color: "var(--emerald-text)", textDecoration: "underline" }}>Terms</span>, <span style={{ color: "var(--emerald-text)", textDecoration: "underline" }}>Privacy</span> & SEBI risk disclosure. Read-only OAuth — we can <strong>never place orders</strong>.</span>
      </label>

      <TVCredit />
      <div style={{ marginTop: 14, display: "flex", justifyContent: "center" }}><ClerkRow>Clerk · OAuth · 2FA optional</ClerkRow></div>
    </Screen>
  );
}

// ── Sign in ──────────────────────────────────────────────────────────────────
function SignInScreen({ go, back }) {
  const [email, setEmail] = useState("rahul@usemoney.ai");
  const [pw, setPw] = useState("");
  const [trust, setTrust] = useState(true);
  return (
    <Screen onBack={back} topPad={60}
      footer={
        <div>
          <PrimaryBtn icon="arrowR" onClick={() => go("twofa")}>Sign in</PrimaryBtn>
          <div style={{ marginTop: 12, textAlign: "center", fontSize: 13, color: "var(--ink-2)" }}>
            New to UseMoney? <button onClick={() => go("signup")} style={{ border: 0, background: "transparent", color: "var(--emerald-text)", fontWeight: 700, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2, whiteSpace: "nowrap" }}>Create an account</button>
          </div>
        </div>
      }>
      <AuthHead eyebrow="SIGN IN · WELCOME BACK"
        h={<>Welcome back. <span className="hl-gold">Today's tape.</span></>}
        sub="Markets are open. Your portfolio is up 0.84%." />

      <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 9 }}>
        <OAuthBtn kind="google" onClick={() => go("dashboard")} />
        <AppleSoonBtn />
        <OAuthBtn kind="phone" onClick={() => go("phone")} />
      </div>
      <OrRule />

      <Field label="Email address" type="email" placeholder="you@email.com" value={email} onChange={setEmail} />
      <Field label="Password" type="password" placeholder="••••••••••" value={pw} onChange={setPw}
        right={null} />
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 7 }}>
        <button onClick={() => go("forgot")} style={{ border: 0, background: "transparent", color: "var(--emerald-text)", fontWeight: 600, fontSize: 12.5, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2 }}>Forgot password?</button>
      </div>

      <label onClick={() => setTrust(t => !t)} style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 16, fontSize: 13, color: "var(--ink-2)", cursor: "pointer" }}>
        <span style={{ width: 20, height: 20, border: "2px solid var(--ink)", borderRadius: 5, background: trust ? "var(--ink)" : "var(--paper)", display: "grid", placeItems: "center" }}>{trust && <Icon name="check" size={12} color="var(--paper)" strokeWidth={3} />}</span>
        Trust this device for 30 days
      </label>

      <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 9, padding: 12, background: "var(--rule-softer)", borderRadius: 11, fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-3)" }}>
        <Icon name="shieldCheck" size={14} color="var(--emerald)" /> 2FA on? You'll be asked for a 6-digit code next.
      </div>
      <TVCredit />
      <div style={{ marginTop: 14, display: "flex", justifyContent: "center" }}><ClerkRow>Powered by Clerk · encrypted</ClerkRow></div>
    </Screen>
  );
}

// ── Verify email (OTP) ───────────────────────────────────────────────────────
function VerifyScreen({ go, back }) {
  const [code, setCode] = useState("");
  const [t, setT] = useState(24);
  useEffect(() => { const id = setInterval(() => setT(x => x > 0 ? x - 1 : 0), 1000); return () => clearInterval(id); }, []);
  return (
    <Screen onBack={back} topPad={60}
      footer={
        <div>
          <PrimaryBtn icon="arrowR" disabled={code.length < 6} onClick={() => go("profile")}>Verify & continue</PrimaryBtn>
          <div style={{ marginTop: 12, textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-3)" }}>
            Didn't get it? {t > 0 ? <span>Resend in {t}s</span> : <span style={{ color: "var(--emerald-text)", textDecoration: "underline" }}>Resend code</span>}
          </div>
        </div>
      }>
      <AuthHead step={{ total: 3, current: 1, label: "VERIFY" }}
        eyebrow="CHECK YOUR INBOX"
        h={<><span className="hl-gold">Six digits</span> <span className="ser">incoming.</span></>}
        sub={null} />
      <p style={{ marginTop: 10, fontSize: 14.5, color: "var(--ink-2)", lineHeight: 1.5 }}>We sent a code to <strong style={{ color: "var(--ink)" }}>rahul@usemoney.ai</strong>. Paste it below.</p>

      <div style={{ marginTop: 30 }}>
        <OTPInput value={code} onChange={setCode} autoFocus />
      </div>

      <div style={{ marginTop: 22, display: "flex", alignItems: "center", gap: 9, padding: 13, background: "var(--paper-3)", border: "1.5px solid var(--rule-soft)", borderRadius: 12 }}>
        <Icon name="clock" size={16} color="var(--ink-3)" />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-3)" }}>Codes expire in 10 minutes.</span>
      </div>
      <div style={{ marginTop: 14, textAlign: "center" }}>
        <button onClick={back} style={{ border: 0, background: "transparent", fontSize: 12.5, color: "var(--emerald-text)", textDecoration: "underline", textUnderlineOffset: 2, cursor: "pointer" }}>Use a different email</button>
      </div>
    </Screen>
  );
}

// ── Phone number entry ───────────────────────────────────────────────────────
function PhoneScreen({ go, back }) {
  const [num, setNum] = useState("");
  return (
    <Screen onBack={back} topPad={60}
      footer={<PrimaryBtn icon="arrowR" disabled={num.length < 10} onClick={() => go("phoneotp")}>Send code via SMS</PrimaryBtn>}>
      <AuthHead
        eyebrow="SECURE YOUR ACCOUNT"
        h={<>Add your <span className="hl-gold">number.</span></>}
        sub="We'll text a one-time code. Used for 2FA and recovery — never for marketing." />

      <Field label="Mobile number" prefix="+91" type="tel" placeholder="98765 43210" value={num} onChange={(v) => setNum(v.replace(/\D/g, "").slice(0, 10))} autoFocus />

      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 10 }}>
        {[
          { i: "shieldCheck", t: "Two-factor authentication", d: "Required for sign-ins on new devices." },
          { i: "refresh", t: "Account recovery", d: "Get back in if you lose your password." },
        ].map(r => (
          <div key={r.t} style={{ display: "flex", gap: 11, alignItems: "center", padding: 12, background: "var(--paper-3)", border: "1.5px solid var(--rule-soft)", borderRadius: 12 }}>
            <span style={{ width: 34, height: 34, borderRadius: 9, background: "var(--emerald-bg)", border: "1.5px solid var(--emerald)", display: "grid", placeItems: "center", flexShrink: 0 }}><Icon name={r.i} size={17} color="var(--emerald-text)" /></span>
            <div><div style={{ fontSize: 13.5, fontWeight: 800, color: "var(--ink)" }}>{r.t}</div><div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{r.d}</div></div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 18, textAlign: "center" }}>
        <button onClick={() => go("dashboard")} style={{ border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-3)", letterSpacing: 0.5, cursor: "pointer", textTransform: "uppercase" }}>Skip for now →</button>
      </div>
    </Screen>
  );
}

// ── SMS OTP ──────────────────────────────────────────────────────────────────
function PhoneOTPScreen({ go, back }) {
  const [code, setCode] = useState("");
  const [t, setT] = useState(30);
  useEffect(() => { const id = setInterval(() => setT(x => x > 0 ? x - 1 : 0), 1000); return () => clearInterval(id); }, []);
  return (
    <Screen onBack={back} topPad={60}
      footer={
        <div>
          <PrimaryBtn icon="arrowR" disabled={code.length < 6} onClick={() => go("dashboard")}>Verify number</PrimaryBtn>
          <div style={{ marginTop: 12, textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-3)" }}>
            {t > 0 ? <span>Resend SMS in {t}s</span> : <span style={{ color: "var(--emerald-text)", textDecoration: "underline" }}>Resend SMS</span>}
          </div>
        </div>
      }>
      <AuthHead step={{ total: 3, current: 2, label: "VERIFY PHONE" }}
        eyebrow="SMS SENT"
        h={<>Enter the <span className="hl-gold">SMS code.</span></>}
        sub={null} />
      <p style={{ marginTop: 10, fontSize: 14.5, color: "var(--ink-2)", lineHeight: 1.5 }}>Sent to <strong style={{ color: "var(--ink)" }}>+91 98765 43210</strong>.</p>
      <div style={{ marginTop: 30 }}><OTPInput value={code} onChange={setCode} autoFocus /></div>
      <div style={{ marginTop: 22, display: "flex", alignItems: "center", gap: 9, padding: 13, background: "var(--emerald-bg)", border: "1.5px solid var(--emerald)", borderRadius: 12 }}>
        <Icon name="phone" size={15} color="var(--emerald-text)" />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--emerald-text)" }}>Auto-filling from Messages…</span>
      </div>
    </Screen>
  );
}

// ── 2FA (sign-in) ────────────────────────────────────────────────────────────
function TwoFAScreen({ go, back }) {
  const [code, setCode] = useState("");
  return (
    <Screen onBack={back} topPad={60}
      footer={
        <div>
          <PrimaryBtn icon="arrowR" disabled={code.length < 6} onClick={() => go("dashboard")}>Verify & sign in</PrimaryBtn>
          <div style={{ marginTop: 12, textAlign: "center" }}>
            <button style={{ border: 0, background: "transparent", fontSize: 12.5, color: "var(--emerald-text)", textDecoration: "underline", textUnderlineOffset: 2, cursor: "pointer" }}>Try another method</button>
          </div>
        </div>
      }>
      <AuthHead eyebrow="TWO-FACTOR · ALMOST IN"
        eyebrowColor="var(--pop-3-text)"
        h={<>Enter your <span className="hl-gold">2FA code.</span></>}
        sub={null} />
      <p style={{ marginTop: 10, fontSize: 14.5, color: "var(--ink-2)", lineHeight: 1.5 }}>Open your authenticator app and enter the 6-digit code for UseMoney.</p>
      <div style={{ marginTop: 30 }}><OTPInput value={code} onChange={setCode} autoFocus /></div>

      <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: 13, background: "var(--paper-3)", border: "1.5px solid var(--rule-soft)", borderRadius: 12 }}>
          <Icon name="fingerprint" size={16} color="var(--ink-3)" />
          <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>Or unlock with <strong style={{ color: "var(--ink)" }}>Face ID</strong></span>
          <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--emerald-text)", textDecoration: "underline" }}>USE</span>
        </div>
      </div>
    </Screen>
  );
}

// ── Forgot password ──────────────────────────────────────────────────────────
function ForgotScreen({ go, back }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  return (
    <Screen onBack={back} topPad={60}
      footer={sent
        ? <PrimaryBtn icon="arrowR" onClick={() => go("reset")}>Open reset link</PrimaryBtn>
        : <PrimaryBtn icon="send" disabled={!email} onClick={() => setSent(true)}>Email me the link</PrimaryBtn>}>
      <AuthHead eyebrow="FORGOT PASSWORD · NO DRAMA"
        eyebrowColor="var(--pop-1-text)"
        h={sent ? <>Check your <span className="hl-gold">inbox.</span></> : <>It happens. <span className="ser">We'll send</span> a <span className="hl-gold">reset link.</span></>}
        sub={sent ? null : "Type the email you signed up with. The link is single-use and expires in 30 minutes."} />

      {sent ? (
        <div style={{ marginTop: 26, padding: 18, background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 14, boxShadow: "4px 4px 0 var(--ink)", textAlign: "center" }}>
          <span style={{ width: 54, height: 54, borderRadius: 14, background: "var(--emerald)", display: "inline-grid", placeItems: "center", marginBottom: 12 }}><Icon name="mail" size={26} color="#fff" /></span>
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>Link sent to {email || "your email"}</div>
          <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 6, lineHeight: 1.5 }}>Tap the button in the email, or use the demo button below to preview the reset screen.</div>
        </div>
      ) : (
        <Field label="Email address" type="email" placeholder="you@email.com" value={email} onChange={setEmail} autoFocus />
      )}

      <div style={{ marginTop: 22, padding: 14, background: "var(--rule-softer)", borderRadius: 12, border: "1.5px dashed var(--rule-soft)" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 1 }}>PROTECTED BY CLERK</div>
        <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 }}>We rate-limit reset emails to one per 60 seconds. Your account isn't locked — you can still sign in if you remember the old password.</div>
      </div>
      <div style={{ marginTop: 16, textAlign: "center" }}>
        <button onClick={() => go("signin")} style={{ border: 0, background: "transparent", fontSize: 12.5, color: "var(--emerald-text)", textDecoration: "underline", textUnderlineOffset: 2, cursor: "pointer" }}>Back to sign-in</button>
      </div>
    </Screen>
  );
}

// ── Set new password ─────────────────────────────────────────────────────────
function ResetScreen({ go, back }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const match = pw && pw === pw2;
  const reqs = [
    { ok: pw.length >= 12, t: "12+ characters" },
    { ok: /\d/.test(pw), t: "Contains a number" },
    { ok: /[^A-Za-z0-9]/.test(pw), t: "Contains a symbol" },
  ];
  return (
    <Screen onBack={back} topPad={60}
      footer={<PrimaryBtn icon="check" disabled={!match || !reqs.every(r => r.ok)} onClick={() => go("signin")}>Set new password</PrimaryBtn>}>
      <AuthHead eyebrow="RESET · SET A NEW PASSWORD"
        h={<>Pick a <span className="hl-gold">fresh</span> <span className="ser">password.</span></>}
        sub="Make it strong — you won't need it often once 2FA is on." />

      <Field label="New password" type="password" placeholder="New password" value={pw} onChange={setPw} autoFocus />
      <Field label="Confirm password" type="password" placeholder="Type it again" value={pw2} onChange={setPw2}
        right={pw2 ? <Icon name={match ? "check" : "x"} size={16} color={match ? "var(--emerald-text)" : "var(--pop-1-text)"} /> : null} />

      <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 8 }}>
        {reqs.map(r => (
          <div key={r.t} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13 }}>
            <span style={{ width: 18, height: 18, borderRadius: 99, border: `2px solid ${r.ok ? "var(--emerald)" : "var(--rule-soft)"}`, background: r.ok ? "var(--emerald)" : "transparent", display: "grid", placeItems: "center" }}>{r.ok && <Icon name="check" size={11} color="#fff" strokeWidth={3} />}</span>
            <span style={{ color: r.ok ? "var(--ink)" : "var(--ink-3)" }}>{r.t}</span>
          </div>
        ))}
      </div>
    </Screen>
  );
}

Object.assign(window, { SignUpScreen, SignInScreen, VerifyScreen, PhoneScreen, PhoneOTPScreen, TwoFAScreen, ForgotScreen, ResetScreen });
