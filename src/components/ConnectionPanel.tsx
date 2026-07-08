import { KeyRound, Pencil, Plug, PlugZap, Plus, Server, Trash2, X } from "lucide-react";
import { FormEvent, useState } from "react";
import { formatSshTarget, normalizeHost } from "../../shared/net";
import type { ServerProfile } from "../../shared/types";
import type { TFunction } from "../lib/i18n";
import { emptyProfile } from "../lib/sample";

type Props = {
  profiles: ServerProfile[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onDisconnect: (id: string) => void;
  onCreate: (profile: Omit<ServerProfile, "id" | "createdAt" | "updatedAt">) => void;
  onUpdate: (profile: ServerProfile) => void;
  onDelete: (id: string) => void;
  t: TFunction;
};

export function ConnectionPanel({ profiles, selectedId, onSelect, onDisconnect, onCreate, onUpdate, onDelete, t }: Props) {
  const [draft, setDraft] = useState(emptyProfile);
  const [editingProfile, setEditingProfile] = useState<ServerProfile | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const normalizedDraft = {
      ...draft,
      host: normalizeHost(draft.host)
    };
    if (editingProfile) {
      onUpdate({
        ...editingProfile,
        ...normalizedDraft
      });
      setEditingProfile(null);
      setDraft({ ...emptyProfile, name: t("newVps") });
      return;
    }
    onCreate(normalizedDraft);
    setDraft({ ...emptyProfile, name: t("newVps") });
  }

  function startEdit(profile: ServerProfile) {
    setEditingProfile(profile);
    setDraft({
      name: profile.name,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      credentialKind: profile.credentialKind,
      password: profile.password ?? "",
      privateKey: profile.privateKey ?? "",
      passphrase: profile.passphrase ?? ""
    });
    onSelect(profile.id);
  }

  function cancelEdit() {
    setEditingProfile(null);
    setDraft({ ...emptyProfile, name: t("newVps") });
  }

  return (
    <aside className="side-panel">
      <div className="panel-title">
        <Server size={18} />
        <span>{t("connections")}</span>
      </div>
      <div className="connection-list">
        {profiles.map((profile) => (
          <div key={profile.id} className={profile.id === selectedId ? "connection-item active" : "connection-item"}>
            <button className="connection-main" onClick={() => onSelect(profile.id)} type="button">
              <span>{profile.name}</span>
              <small>
                {formatSshTarget(profile.username, profile.host, profile.port)}
              </small>
            </button>
            <span className="connection-actions">
              {profile.id === selectedId ? (
                <button
                  type="button"
                  aria-label={t("disconnect")}
                  title={t("disconnect")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDisconnect(profile.id);
                  }}
                >
                  <PlugZap size={15} />
                </button>
              ) : (
                <button
                  type="button"
                  aria-label={t("connect")}
                  title={t("connect")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(profile.id);
                  }}
                >
                  <Plug size={15} />
                </button>
              )}
              <button
                type="button"
                aria-label={t("editConnection")}
                onClick={(event) => {
                  event.stopPropagation();
                  startEdit(profile);
                }}
              >
                <Pencil size={15} />
              </button>
              <button
                type="button"
                aria-label={t("deleteConnection")}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(profile.id);
                }}
              >
                <Trash2 size={15} />
              </button>
            </span>
          </div>
        ))}
      </div>
      <form className="connection-form" onSubmit={submit}>
        <div className="panel-title compact">
          {editingProfile ? <Pencil size={16} /> : <Plus size={16} />}
          <span>{editingProfile ? t("editConnection") : t("saveVps")}</span>
          {editingProfile ? (
            <button className="inline-icon-button" type="button" title={t("cancel")} onClick={cancelEdit}>
              <X size={15} />
            </button>
          ) : null}
        </div>
        <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t("name")} />
        <input value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} placeholder={t("host")} />
        <div className="split-inputs">
          <input
            value={draft.port}
            onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })}
            type="number"
            min={1}
            max={65535}
          />
          <input value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} placeholder={t("username")} />
        </div>
        <select
          value={draft.credentialKind}
          onChange={(event) => setDraft({ ...draft, credentialKind: event.target.value as ServerProfile["credentialKind"] })}
        >
          <option value="password">{t("password")}</option>
          <option value="privateKey">{t("privateKey")}</option>
        </select>
        {draft.credentialKind === "password" ? (
          <input
            value={draft.password ?? ""}
            onChange={(event) => setDraft({ ...draft, password: event.target.value })}
            placeholder={t("sshPassword")}
            type="password"
          />
        ) : (
          <textarea
            value={draft.privateKey ?? ""}
            onChange={(event) => setDraft({ ...draft, privateKey: event.target.value })}
            placeholder={t("pastePrivateKey")}
            rows={5}
          />
        )}
        <button className="secondary-button" type="submit">
          <KeyRound size={16} />
          {editingProfile ? t("updateConnection") : t("saveConnection")}
        </button>
      </form>
    </aside>
  );
}
