/**
 * Virtualized, responsive grid of asset cards with drag-to-add and preview support.
 *
 * @module VirtualizedAssetGrid
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { Plus } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { setModelLibraryDragData } from "../modelLibrary/modelLibraryDrag";
import type { ModelLibraryItem } from "../modelLibrary/modelLibraryCatalog";
import { ModelLibraryThumb } from "./ModelLibraryThumb";
import {
  getAssetLibraryColumnCount,
  getAssetLibraryRowSize,
  readAssetLibraryViewportWidth,
} from "./virtualizedAssetGridLayout";

const VERTICAL_PADDING_TOP = 10;
const VERTICAL_PADDING_BOTTOM = 16;
const VIRTUALIZATION_THRESHOLD = 60;
const INITIAL_VIEWPORT_WIDTH = 248;
const INITIAL_VIEWPORT_HEIGHT = 560;

const AssetCard = memo(function AssetCard({
  item,
  itemIndex,
  itemCount,
  onAdd,
  onPreview,
}: {
  item: ModelLibraryItem;
  itemIndex: number;
  itemCount: number;
  onAdd: (item: ModelLibraryItem) => void;
  onPreview: (item: ModelLibraryItem) => void;
}) {
  const [dragging, setDragging] = useState(false);

  return (
    <div aria-posinset={itemIndex + 1} aria-setsize={itemCount} className="model-library-card-wrap" role="listitem">
      <button
        aria-label={`预览模型 ${item.name}`}
        className={`model-library-card${dragging ? " is-dragging" : ""}`}
        draggable
        title="拖到场景放置；单击预览"
        type="button"
        onClick={() => onPreview(item)}
        onDragEnd={() => setDragging(false)}
        onDragStart={(event) => {
          setDragging(true);
          setModelLibraryDragData(event, item);
        }}
      >
        <ModelLibraryThumb item={item} name={item.name} showPreviewCue thumbnailUrl={item.thumbnailUrl} />
        <span className="model-library-name" data-i18n-user-content>
          {item.name}
        </span>
      </button>
      <button
        aria-label={`添加模型 ${item.name}`}
        className="model-library-card-add"
        title="添加至场景"
        type="button"
        onClick={() => onAdd(item)}
      >
        <Plus size={14} strokeWidth={2} />
      </button>
    </div>
  );
});

/**
 * Renders a virtualized grid of asset cards that switches to row virtualization
 * when the item count exceeds a threshold, with drag-and-drop and preview buttons.
 */
export const VirtualizedAssetGrid = memo(function VirtualizedAssetGrid({
  items,
  onAdd,
  onPreview,
}: {
  items: ModelLibraryItem[];
  onAdd: (item: ModelLibraryItem) => void;
  onPreview: (item: ModelLibraryItem) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(INITIAL_VIEWPORT_WIDTH);
  const virtualized = items.length > VIRTUALIZATION_THRESHOLD;
  const columnCount = getAssetLibraryColumnCount(viewportWidth);
  const rowSize = getAssetLibraryRowSize(viewportWidth, columnCount);
  const rowCount = Math.ceil(items.length / columnCount);
  const rowVirtualizer = useVirtualizer({
    count: virtualized ? rowCount : 0,
    estimateSize: () => rowSize,
    getItemKey: (rowIndex) => items[rowIndex * columnCount]?.id ?? rowIndex,
    getScrollElement: () => scrollRef.current,
    initialRect: { height: INITIAL_VIEWPORT_HEIGHT, width: INITIAL_VIEWPORT_WIDTH },
    overscan: 3,
    useFlushSync: false,
  });

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const updateWidth = () => {
      // Prefer the visible border box. `clientWidth` can stay on the 248px
      // fallback when `contain: size` or a hidden first layout reports a
      // smaller content box, which stretched two cards across a wide panel.
      const nextWidth = readAssetLibraryViewportWidth(element);
      if (nextWidth > 0) setViewportWidth((current) => (current === nextWidth ? current : nextWidth));
    };

    updateWidth();
    const frame = window.requestAnimationFrame(updateWidth);
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(updateWidth);
      observer.observe(element);
      if (element.parentElement) observer.observe(element.parentElement);
      const panel = element.closest(".asset-library-panel, .right-sidebar-body, .right-sidebar");
      if (panel instanceof HTMLElement && panel !== element && panel !== element.parentElement) {
        observer.observe(panel);
      }
      return () => {
        window.cancelAnimationFrame(frame);
        observer.disconnect();
      };
    }

    window.addEventListener("resize", updateWidth);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateWidth);
    };
  }, [virtualized]);

  useEffect(() => {
    if (!virtualized) return;
    rowVirtualizer.measure();
  }, [columnCount, rowCount, rowSize, rowVirtualizer, virtualized]);

  useEffect(() => {
    if (!virtualized) return;
    rowVirtualizer.scrollToOffset(0);
  }, [items, rowVirtualizer, virtualized]);

  if (!virtualized) {
    return (
      <div className="model-library-grid asset-library-grid" role="list" aria-label="模型列表">
        {items.map((item, itemIndex) => (
          <AssetCard
            key={item.id}
            item={item}
            itemCount={items.length}
            itemIndex={itemIndex}
            onAdd={onAdd}
            onPreview={onPreview}
          />
        ))}
        {!items.length ? <p className="asset-library-no-results">此分类暂无匹配组件。</p> : null}
      </div>
    );
  }

  const measuredRows = rowVirtualizer.getVirtualItems();
  const initialVisibleRowCount = Math.min(rowCount, Math.ceil(INITIAL_VIEWPORT_HEIGHT / rowSize) + 3);
  const visibleRows = measuredRows.length
    ? measuredRows
    : Array.from({ length: initialVisibleRowCount }, (_, index) => ({
        index,
        key: `initial-${items[index * columnCount]?.id ?? index}`,
        start: index * rowSize,
      }));

  return (
    <div
      ref={scrollRef}
      aria-label="模型列表"
      className="model-library-grid asset-library-grid asset-library-grid-virtualized"
      data-column-count={columnCount}
      role="list"
    >
      <div
        className="asset-library-virtual-content"
        style={{ height: rowVirtualizer.getTotalSize() + VERTICAL_PADDING_TOP + VERTICAL_PADDING_BOTTOM }}
      >
        {visibleRows.map((virtualRow) => {
          const firstItemIndex = virtualRow.index * columnCount;
          const rowItems = items.slice(firstItemIndex, firstItemIndex + columnCount);
          return (
            <div
              key={virtualRow.key}
              className="asset-library-virtual-row"
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              style={{
                gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                transform: `translateY(${virtualRow.start + VERTICAL_PADDING_TOP}px)`,
              }}
            >
              {rowItems.map((item, columnIndex) => (
                <AssetCard
                  key={item.id}
                  item={item}
                  itemCount={items.length}
                  itemIndex={firstItemIndex + columnIndex}
                  onAdd={onAdd}
                  onPreview={onPreview}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
});
