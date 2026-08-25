/**
 * 虚拟化对象列表，当条目数量超过阈值时使用 @tanstack/react-virtual 渲染，否则渲染普通列表。
 *
 * @module virtualized-object-list
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useState, type CSSProperties, type ReactElement, type RefObject } from "react";

/** 启用虚拟化渲染的对象列表条目数阈值。 */
export const OBJECT_TREE_VIRTUALIZATION_THRESHOLD = 120;

const ESTIMATED_ROW_HEIGHT = 36;
const INITIAL_VIEWPORT_HEIGHT = 720;
const INITIAL_VIEWPORT_WIDTH = 248;
const OVERSCAN_ROWS = 8;

/** 虚拟化行的布局信息，传递给渲染函数用于定位和测量。 */
export type VirtualizedObjectRowLayout = {
  index: number;
  measureElement: (node: Element | null) => void;
  style: CSSProperties;
};

/**
 * 渲染一个对象列表，当条目数超过阈值时自动启用虚拟化，否则渲染普通列表。
 * @param items - 要渲染的对象列表。
 * @param renderItem - 每个条目的渲染函数，接收条目和可选的虚拟化行布局信息。
 * @param scrollRef - 滚动容器的引用。
 * @param scrollToId - 可选，滚动到指定 ID 的条目。
 */
export function VirtualizedObjectList<T extends { id: string }>({
  items,
  renderItem,
  scrollRef,
  scrollToId,
}: {
  items: T[];
  renderItem: (item: T, layout?: VirtualizedObjectRowLayout) => ReactElement;
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollToId?: string | null;
}) {
  const [listElement, setListElement] = useState<HTMLUListElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const virtualized = items.length > OBJECT_TREE_VIRTUALIZATION_THRESHOLD;
  const rowVirtualizer = useVirtualizer({
    count: virtualized ? items.length : 0,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    getItemKey: (index) => items[index]?.id ?? index,
    getScrollElement: () => scrollRef.current,
    initialRect: { height: INITIAL_VIEWPORT_HEIGHT, width: INITIAL_VIEWPORT_WIDTH },
    overscan: OVERSCAN_ROWS,
    scrollMargin,
    useFlushSync: false,
  });

  useLayoutEffect(() => {
    if (!virtualized || !listElement) return;
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;

    const updateScrollMargin = () => {
      const nextMargin =
        listElement.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop;
      setScrollMargin((current) => (current === nextMargin ? current : nextMargin));
    };

    updateScrollMargin();
    const frame = window.requestAnimationFrame(updateScrollMargin);
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(updateScrollMargin);
      observer.observe(scrollElement);
      observer.observe(listElement);
      return () => {
        window.cancelAnimationFrame(frame);
        observer.disconnect();
      };
    }

    window.addEventListener("resize", updateScrollMargin);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateScrollMargin);
    };
  }, [items.length, listElement, scrollRef, virtualized]);

  useLayoutEffect(() => {
    if (!scrollToId) return;
    const index = items.findIndex((item) => item.id === scrollToId);
    if (index < 0) return;
    if (virtualized) {
      rowVirtualizer.scrollToIndex(index, { align: "auto" });
      return;
    }
    const row = scrollRef.current?.querySelector(`[data-object-tree-id="${CSS.escape(scrollToId)}"]`);
    if (row instanceof HTMLElement && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [items, rowVirtualizer, scrollRef, scrollToId, virtualized]);

  if (!virtualized) {
    return <ul className="object-list">{items.map((item) => renderItem(item))}</ul>;
  }

  const measuredRows = rowVirtualizer.getVirtualItems();
  const initialRowCount = Math.min(
    items.length,
    Math.ceil(INITIAL_VIEWPORT_HEIGHT / ESTIMATED_ROW_HEIGHT) + OVERSCAN_ROWS,
  );
  const visibleRows = measuredRows.length
    ? measuredRows
    : Array.from({ length: initialRowCount }, (_, index) => ({
        index,
        key: items[index]?.id ?? index,
        start: index * ESTIMATED_ROW_HEIGHT,
      }));

  return (
    <ul
      ref={setListElement}
      className="object-list object-list-virtualized"
      style={{ display: "block", height: rowVirtualizer.getTotalSize(), position: "relative" }}
    >
      {visibleRows.map((virtualRow) =>
        renderItem(items[virtualRow.index]!, {
          index: virtualRow.index,
          measureElement: rowVirtualizer.measureElement,
          style: {
            left: 0,
            position: "absolute",
            top: 0,
            transform: `translateY(${virtualRow.start - scrollMargin}px)`,
            width: "100%",
          },
        }),
      )}
    </ul>
  );
}
