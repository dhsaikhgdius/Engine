/**
 * Dropdown menu with links to documentation and keyboard shortcuts.
 *
 * @module HelpMenu
 */

import { BookOpen, CircleHelp, Keyboard } from "lucide-react";
import { useLanguage } from "../../i18n/language";
import { openDirectorEditorShortcuts } from "../../editor/keyboard/EditorShortcuts";
import { useDropdownDisclosure } from "../../editor/useDropdownDisclosure";
import { DIRECTOR_DOCS_URL } from "../welcome/WelcomeGuide";
import "./HelpMenu.css";

/**
 * Renders a help dropdown that opens the local docs site or the keyboard shortcuts dialog.
 */
export function HelpMenu() {
  const { t } = useLanguage();
  const { dropdownRef, handleTriggerKeyDown, isOpen, setIsOpen } = useDropdownDisclosure();

  return (
    <div className="help-menu" ref={dropdownRef}>
      <button
        aria-controls="help-menu-popover"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        className={`top-bar-settings-trigger${isOpen ? " is-active" : ""}`}
        title={t("帮助与文档")}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleTriggerKeyDown}
      >
        <CircleHelp aria-hidden size={14} />
        <span className="top-bar-settings-label">{t("帮助")}</span>
      </button>
      {isOpen ? (
        <div aria-label={t("帮助菜单")} className="help-menu-popover" id="help-menu-popover" role="menu">
          <a
            className="help-menu-item"
            href={DIRECTOR_DOCS_URL}
            rel="noreferrer"
            role="menuitem"
            target="_blank"
            onClick={() => setIsOpen(false)}
          >
            <span aria-hidden className="help-menu-item-icon">
              <BookOpen size={14} />
            </span>
            <span className="help-menu-item-copy">
              <strong>{t("打开文档")}</strong>
              <small>{t("本地文档站，需先运行 npm run docs:dev")}</small>
            </span>
          </a>
          <button
            className="help-menu-item"
            role="menuitem"
            type="button"
            onClick={() => {
              setIsOpen(false);
              openDirectorEditorShortcuts();
            }}
          >
            <span aria-hidden className="help-menu-item-icon">
              <Keyboard size={14} />
            </span>
            <span className="help-menu-item-copy">
              <strong>{t("键盘快捷键")}</strong>
              <small>{t("也可随时按 Shift + / 唤起")}</small>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
