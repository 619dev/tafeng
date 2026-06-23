import { Lock, Moon, ShieldCheck, Sun } from "lucide-react";
import { FormEvent, useState } from "react";
import type { Language } from "../../shared/types";
import { api } from "../lib/api";
import type { TFunction } from "../lib/i18n";

type Props = {
  language: Language;
  t: TFunction;
  onLanguageChange: (language: Language) => void;
  onAuthenticated: () => void;
};

export function LoginGate({ language, t, onLanguageChange, onAuthenticated }: Props) {
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [needsOtp, setNeedsOtp] = useState(false);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api.login(password, otp || undefined);
      onAuthenticated();
    } catch (err) {
      const message = err instanceof Error ? err.message : t("loginFailed");
      setNeedsOtp(message.includes("两步") || message.includes("验证码"));
      setError(message);
    }
  }

  function toggleTheme() {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  return (
    <main className={`login-shell ${theme === "light" ? "login-light" : ""}`}>
      <form className="login-panel" onSubmit={submit}>
        <div className="login-panel-top">
          <div className="traffic-lights" aria-hidden="true">
            <span className="red" />
            <span className="yellow" />
            <span className="green" />
          </div>
          <button type="button" className="theme-toggle" onClick={toggleTheme} title={theme === "dark" ? t("lightTerminal") : t("darkTerminal")}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
        <div className="login-brand">
          <Lock size={28} />
          <div>
            <h1>{t("appName")}</h1>
            <p>{t("productName")}</p>
          </div>
        </div>
        <select className="language-select" value={language} onChange={(event) => onLanguageChange(event.target.value as Language)}>
          <option value="zh">{t("languageZh")}</option>
          <option value="en">{t("languageEn")}</option>
        </select>
        <label>
          {t("managementPassword")}
          <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoFocus />
        </label>
        {needsOtp ? (
          <label>
            {t("twoFactorCode")}
            <input value={otp} onChange={(event) => setOtp(event.target.value)} inputMode="numeric" />
          </label>
        ) : null}
        {error ? <p className="form-error">{error}</p> : null}
        <button className="primary-button" type="submit">
          <ShieldCheck size={18} />
          {t("enterConsole")}
        </button>
      </form>
    </main>
  );
}
