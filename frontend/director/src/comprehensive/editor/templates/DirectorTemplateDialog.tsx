import { LayoutTemplate, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { notifyDirector } from "../../app/notifications/directorNotificationStore";
import { useLanguage } from "../../i18n/language";
import type { DirectorProject } from "../schema/directorProject";
import { createDefaultDirectorProject, useDirectorStore } from "../store/directorStore";
import { buildDirectorSceneTemplateProject, DIRECTOR_SCENE_TEMPLATES, type DirectorSceneTemplate } from "./index";
import "./DirectorTemplateDialog.css";

/**
 * 判断当前工程是否仍是未经改动的出厂默认工程。默认工程是确定性生成的，
 * 因此可以做结构化对比；一旦用户动过任何内容（含默认角色的位移），
 * 载入模板前就需要内联确认。
 */
export function isDirectorProjectFactoryDefault(project: DirectorProject): boolean {
  try {
    return JSON.stringify(project) === JSON.stringify(createDefaultDirectorProject());
  } catch {
    return false;
  }
}

function TemplateThumbnail({ templateId }: { templateId: string }) {
  const shared = { fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg aria-hidden className="director-template-thumb" viewBox="0 0 96 54">
      {/* 地平线：所有模板共用的舞台基准。 */}
      <line x1="8" x2="88" y1="44" y2="44" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" {...shared} />
      {templateId === "empty-stage" ? (
        <g stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.2" {...shared}>
          <path d="M24 44 L40 30 L72 30 L88 44" />
          <line x1="34" x2="62" y1="37" y2="37" />
          <line x1="48" x2="56" y1="44" y2="30" />
        </g>
      ) : templateId === "dialogue-two-characters" ? (
        <g stroke="currentColor" strokeWidth="1.6" {...shared}>
          <circle cx="36" cy="30" r="4.5" />
          <path d="M36 35 L36 44" />
          <circle cx="60" cy="30" r="4.5" />
          <path d="M60 35 L60 44" />
          <path d="M43 31 L53 31" strokeDasharray="2.5 2.5" strokeOpacity="0.6" />
          <path d="M18 18 L26 22 L18 26 Z" strokeOpacity="0.8" />
          <path d="M78 18 L70 22 L78 26 Z" strokeOpacity="0.8" />
        </g>
      ) : templateId === "three-point-portrait" ? (
        <g stroke="currentColor" strokeWidth="1.6" {...shared}>
          <circle cx="48" cy="29" r="5" />
          <path d="M48 34 L48 44" />
          <path d="M20 12 L41 26" strokeDasharray="3 3" strokeOpacity="0.75" />
          <path d="M76 12 L55 26" strokeDasharray="3 3" strokeOpacity="0.75" />
          <path d="M48 6 L48 20" strokeDasharray="3 3" strokeOpacity="0.75" />
          <circle cx="18" cy="10" r="2.6" strokeOpacity="0.9" />
          <circle cx="78" cy="10" r="2.6" strokeOpacity="0.9" />
          <circle cx="48" cy="4.6" r="2.6" strokeOpacity="0.9" />
        </g>
      ) : templateId === "orbit-showcase" ? (
        <g stroke="currentColor" strokeWidth="1.6" {...shared}>
          <circle cx="48" cy="30" r="4.5" />
          <path d="M48 34 L48 44" />
          <ellipse cx="48" cy="31" rx="30" ry="12" strokeDasharray="3 3" strokeOpacity="0.7" />
          <path d="M80 26 L74 31 L82 33 Z" strokeOpacity="0.9" />
        </g>
      ) : (
        <g stroke="currentColor" strokeWidth="1.6" {...shared}>
          <circle cx="58" cy="27" r="4.5" />
          <path d="M58 32 L58 44" />
          <path d="M24 40 L76 40" strokeDasharray="3 3" strokeOpacity="0.6" />
          <path d="M76 40 L70 36 M76 40 L70 44" strokeOpacity="0.6" />
          <path d="M22 20 L30 24 L22 28 Z" strokeOpacity="0.9" />
          <path d="M34 24 L44 26" strokeDasharray="2.5 2.5" strokeOpacity="0.6" />
        </g>
      )}
    </svg>
  );
}

export function DirectorTemplateDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage();
  const surfaceRef = useRef<HTMLElement | null>(null);
  const [pendingTemplate, setPendingTemplate] = useState<DirectorSceneTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    surfaceRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  function applyTemplate(template: DirectorSceneTemplate) {
    try {
      const project = buildDirectorSceneTemplateProject(template);
      useDirectorStore.getState().replaceProject(project);
      notifyDirector({
        key: "director-scene-template-applied",
        severity: "success",
        title: `已从模板「${template.name}」新建 3D 片场工程`,
        detail: "原工程内容可通过撤销恢复。",
      });
      onClose();
    } catch (loadError) {
      setPendingTemplate(null);
      setError(loadError instanceof Error ? loadError.message : t("模板载入失败"));
    }
  }

  function chooseTemplate(template: DirectorSceneTemplate) {
    setError(null);
    if (isDirectorProjectFactoryDefault(useDirectorStore.getState().project)) {
      applyTemplate(template);
      return;
    }
    setPendingTemplate(template);
  }

  return (
    <div aria-label={t("从模板新建 3D 片场")} aria-modal="true" className="director-template-dialog" role="dialog">
      <button aria-label={t("关闭模板选择")} className="director-template-backdrop" onClick={onClose} type="button" />
      <section className="director-template-surface" ref={surfaceRef} tabIndex={-1}>
        <header>
          <div className="director-template-heading">
            <span aria-hidden className="director-template-brand">
              <LayoutTemplate size={15} />
            </span>
            <div>
              <strong>{t("从模板新建 3D 片场")}</strong>
              <span>{t("挑选一套预设的角色、灯光与机位开始创作")}</span>
            </div>
          </div>
          <button aria-label={t("关闭模板选择")} className="ui-icon-button" onClick={onClose} type="button">
            <X aria-hidden size={16} />
          </button>
        </header>
        <ul className="director-template-list">
          {DIRECTOR_SCENE_TEMPLATES.map((template) => (
            <li key={template.id}>
              <button
                aria-label={`${t("使用模板")} ${template.name}`}
                className={`director-template-card${pendingTemplate?.id === template.id ? " is-pending" : ""}`}
                onClick={() => chooseTemplate(template)}
                type="button"
              >
                <TemplateThumbnail templateId={template.id} />
                <strong>{template.name}</strong>
                <p>{template.description}</p>
                <small>{template.useCase}</small>
              </button>
            </li>
          ))}
        </ul>
        <footer className="director-template-footer">
          {pendingTemplate ? (
            <div className="director-template-confirm">
              <p>
                <Undo2 aria-hidden size={13} />
                {t("将替换当前 3D 片场工程（可用撤销恢复）")}
              </p>
              <div>
                <button className="director-template-confirm-cancel" onClick={() => setPendingTemplate(null)} type="button">
                  {t("取消")}
                </button>
                <button
                  className="director-template-confirm-apply"
                  onClick={() => applyTemplate(pendingTemplate)}
                  type="button"
                >
                  {t("确认替换")} · {pendingTemplate.name}
                </button>
              </div>
            </div>
          ) : error ? (
            <p className="director-template-error" role="alert">
              {error}
            </p>
          ) : (
            <p className="director-template-hint">{t("载入模板会开始一个全新工程，可随时用撤销找回当前内容。")}</p>
          )}
        </footer>
      </section>
    </div>
  );
}
