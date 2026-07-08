import { Clock3, Eraser, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatSshTarget } from "../../shared/net";
import type { CommandHistoryEntry } from "../../shared/types";
import { api } from "../lib/api";
import type { TFunction } from "../lib/i18n";

type Props = {
  refreshKey: number;
  t: TFunction;
};

export function CommandHistoryPanel({ refreshKey, t }: Props) {
  const [items, setItems] = useState<CommandHistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");

  async function load() {
    try {
      const result = await api.commandHistory(300);
      setItems(result.items);
      setTotal(result.total);
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("historyLoadFailed"));
    }
  }

  async function clear() {
    await api.clearCommandHistory();
    setItems([]);
    setTotal(0);
  }

  useEffect(() => {
    load();
  }, [refreshKey]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return items;
    return items.filter((item) => {
      return [item.command, item.profileName, item.host, item.username].some((value) => value?.toLowerCase().includes(keyword));
    });
  }, [items, query]);

  return (
    <section className="history-panel">
      <div className="history-toolbar">
        <div className="panel-title">
          <Clock3 size={18} />
          <span>{t("commandHistory")}</span>
          <small>{total} / 100000</small>
        </div>
        <div className="history-actions">
          <button type="button" title={t("refresh")} onClick={load}>
            <RefreshCw size={15} />
          </button>
          <button type="button" title={t("clearHistory")} onClick={clear}>
            <Eraser size={15} />
          </button>
        </div>
      </div>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("searchHistory")} />
      <div className="history-list">
        {filtered.map((item) => (
          <div className="history-item" key={item.id}>
            <code>{item.command}</code>
            <small>
              {item.profileName} · {formatSshTarget(item.username, item.host)} · {new Date(item.createdAt).toLocaleString()}
            </small>
          </div>
        ))}
        {!filtered.length ? <p className="empty-history">{status || t("emptyHistory")}</p> : null}
      </div>
    </section>
  );
}
