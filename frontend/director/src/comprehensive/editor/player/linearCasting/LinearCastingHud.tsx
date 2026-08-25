/**
 * @module LinearCastingHud
 * @description Heads-up display for the linear casting skill system, showing
 *   elemental skill slots with cooldown rings, arm/confirm cues, and a full-screen
 *   flash overlay.
 */

import { Sparkles } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useLanguage } from "../../../i18n/language";
import {
  LINEAR_CASTING_ELEMENTS,
  LINEAR_CASTING_LABELS,
  linearCastingElementMeta,
  type LinearCastingElement,
} from "./linearCastingCatalog";
import { getLinearCastingHudRuntime, subscribeLinearCastingHudRuntime } from "./linearCastingHudBridge";
import {
  getLinearCastingSession,
  setLinearCastingEnabled,
  subscribeLinearCastingSession,
} from "./linearCastingSession";
import { ELEMENT_SIGILS } from "./vendor/ui/glyphs.js";

export function LinearCastingHud() {
  const { t } = useLanguage();
  const session = useSyncExternalStore(subscribeLinearCastingSession, getLinearCastingSession);
  const runtime = useSyncExternalStore(subscribeLinearCastingHudRuntime, getLinearCastingHudRuntime);
  const [armed, setArmed] = useState(false);
  const [selected, setSelected] = useState<LinearCastingElement>("ice");
  const [ratios, setRatios] = useState<Record<string, number>>(() =>
    Object.fromEntries(LINEAR_CASTING_ELEMENTS.map((element) => [element, 0])),
  );
  const [flash, setFlash] = useState({ color: "rgb(255 255 255)", strength: 0 });

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const live = getLinearCastingHudRuntime();
      if (live) {
        setArmed(Boolean(live.aim.isArmed));
        setSelected(live.selected);
        setRatios((current) => {
          let changed = false;
          const next = { ...current };
          for (const element of LINEAR_CASTING_ELEMENTS) {
            const ratio = live.cooldownRatio(element);
            if (next[element] !== ratio) {
              next[element] = ratio;
              changed = true;
            }
          }
          return changed ? next : current;
        });
        const color = live.flash.color;
        const nextColor = `rgb(${Math.round(color.r * 255)} ${Math.round(color.g * 255)} ${Math.round(color.b * 255)})`;
        const nextStrength = live.flash.strength;
        setFlash((current) =>
          current.color === nextColor && current.strength === nextStrength
            ? current
            : { color: nextColor, strength: nextStrength },
        );
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <>
      <aside aria-label={t("技能施放")} className="linear-casting-hud">
        <div className="linear-casting-hud__heading">
          <span>
            <Sparkles aria-hidden size={13} /> {t("技能施放")}
          </span>
          <button
            aria-pressed={session.enabled}
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setLinearCastingEnabled(!session.enabled)}
          >
            {session.enabled ? t("开") : t("关")}
          </button>
        </div>
        {session.paused ? <p className="linear-casting-hud__paused">{t("特效已暂停 · 编辑器仍生效")}</p> : null}
        <div className="linear-casting-hud__bar" role="toolbar" aria-label={t("技能栏")}>
          {LINEAR_CASTING_ELEMENTS.map((element) => {
            const meta = linearCastingElementMeta(element);
            const ratio = ratios[element] ?? 0;
            const active = selected === element;
            return (
              <button
                aria-label={t(LINEAR_CASTING_LABELS[element])}
                aria-pressed={active}
                className={`linear-casting-hud__slot${active ? " is-selected" : ""}${armed && active ? " is-armed" : ""}`}
                disabled={!session.enabled || !runtime}
                key={element}
                style={
                  {
                    "--accent": meta.accent,
                    "--cooldown": String(ratio),
                  } as CSSProperties
                }
                title={`${t(LINEAR_CASTING_LABELS[element])} · ${meta.key}`}
                type="button"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => runtime?.toggleArm(element)}
              >
                <span
                  aria-hidden
                  className="linear-casting-hud__glyph"
                  dangerouslySetInnerHTML={{ __html: ELEMENT_SIGILS[element] }}
                />
                <kbd>{meta.key}</kbd>
                {ratio > 0 ? <span className="linear-casting-hud__cool" /> : null}
              </button>
            );
          })}
        </div>
        <small>
          {armed ? t("瞄准中 · 左键施放 · 右键取消") : t("5–0 武装 · 左键施放 · G 编辑器 · P 暂停 · B 清除")}
        </small>
      </aside>
      <div
        aria-hidden
        className="linear-casting-flash"
        style={{
          background: flash.color,
          opacity: flash.strength * 0.55,
        }}
      />
    </>
  );
}
