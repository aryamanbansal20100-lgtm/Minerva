"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"

export interface FileNode {
  name: string
  type: "file" | "folder"
  children?: FileNode[]
  extension?: string
}

interface FileTreeProps {
  data: FileNode[]
  className?: string
  /** Called with the leaf that was clicked, so the tree can drive a view. */
  onSelect?: (node: FileNode) => void
}

interface FileItemProps {
  node: FileNode
  depth: number
  isLast: boolean
  parentPath: boolean[]
  onSelect?: (node: FileNode) => void
}

const getFileIcon = (extension?: string) => {
  const iconMap: Record<string, { color: string; icon: string }> = {
    pdf: { color: "text-late", icon: "◆" },
    docx: { color: "text-info", icon: "◆" },
    doc: { color: "text-info", icon: "◆" },
    pptx: { color: "text-warn", icon: "◈" },
    xlsx: { color: "text-ok", icon: "▤" },
    png: { color: "text-ok", icon: "◑" },
    jpg: { color: "text-ok", icon: "◑" },
    jpeg: { color: "text-ok", icon: "◑" },
    md: { color: "text-muted-foreground", icon: "◊" },
    txt: { color: "text-muted-foreground", icon: "◊" },
    note: { color: "text-foreground/70", icon: "▪" },
    default: { color: "text-muted-foreground", icon: "◇" },
  }
  return iconMap[extension || "default"] || iconMap.default
}

function FileItem({ node, depth, isLast, parentPath, onSelect }: FileItemProps) {
  const [isOpen, setIsOpen] = useState(true)
  const [isHovered, setIsHovered] = useState(false)

  const isFolder = node.type === "folder"
  const hasChildren = isFolder && node.children && node.children.length > 0
  const fileIcon = getFileIcon(node.extension)

  return (
    <div className="select-none">
      <div
        className={cn(
          "group relative flex items-center gap-2 py-1 px-2 rounded-md cursor-pointer",
          "transition-colors duration-150 ease-out",
          isHovered && "bg-file-tree-hover",
        )}
        onClick={() => (isFolder ? setIsOpen(!isOpen) : onSelect?.(node))}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {depth > 0 && (
          <div
            className="absolute top-0 bottom-0 flex"
            style={{ left: `${(depth - 1) * 16 + 16}px` }}
          >
            <div
              className={cn(
                "w-px transition-colors duration-150",
                isHovered ? "bg-foreground/25" : "bg-border",
              )}
            />
          </div>
        )}

        <div
          className={cn(
            "flex items-center justify-center w-4 h-4 transition-transform duration-150 ease-out",
            isFolder && isOpen && "rotate-90",
          )}
        >
          {isFolder ? (
            <svg
              width="6"
              height="8"
              viewBox="0 0 6 8"
              fill="none"
              className={cn(
                "transition-colors duration-150",
                isHovered ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <path
                d="M1 1L5 4L1 7"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <span className={cn("text-xs", fileIcon.color)}>{fileIcon.icon}</span>
          )}
        </div>

        <div
          className={cn(
            "flex items-center justify-center w-5 h-5 rounded transition-colors duration-150",
            isFolder
              ? "text-folder-icon"
              : cn(fileIcon.color, isHovered ? "" : "opacity-75"),
          )}
        >
          {isFolder ? (
            <svg width="16" height="14" viewBox="0 0 16 14" fill="currentColor">
              <path d="M1.5 1C0.671573 1 0 1.67157 0 2.5V11.5C0 12.3284 0.671573 13 1.5 13H14.5C15.3284 13 16 12.3284 16 11.5V4.5C16 3.67157 15.3284 3 14.5 3H8L6.5 1H1.5Z" />
            </svg>
          ) : (
            <svg width="14" height="16" viewBox="0 0 14 16" fill="currentColor" opacity="0.85">
              <path d="M1.5 0C0.671573 0 0 0.671573 0 1.5V14.5C0 15.3284 0.671573 16 1.5 16H12.5C13.3284 16 14 15.3284 14 14.5V4.5L9.5 0H1.5Z" />
              <path d="M9 0V4.5H14" fill="currentColor" fillOpacity="0.5" />
            </svg>
          )}
        </div>

        <span
          className={cn(
            "font-mono text-[13px] transition-colors duration-150 truncate",
            isFolder
              ? "text-foreground/90"
              : isHovered
                ? "text-foreground"
                : "text-muted-foreground",
          )}
        >
          {node.name}
        </span>
      </div>

      {hasChildren && (
        <div
          className={cn(
            "overflow-hidden transition-all duration-200 ease-out",
            isOpen ? "opacity-100" : "opacity-0 h-0",
          )}
          style={{ maxHeight: isOpen ? `${node.children!.length * 120}px` : "0px" }}
        >
          {node.children!.map((child, index) => (
            <FileItem
              key={child.name + index}
              node={child}
              depth={depth + 1}
              isLast={index === node.children!.length - 1}
              parentPath={[...parentPath, !isLast]}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function FileTree({ data, className, onSelect }: FileTreeProps) {
  return (
    <div
      className={cn(
        "bg-file-tree-bg rounded-lg border p-3 font-mono",
        className,
      )}
    >
      <div className="flex items-center gap-2 pb-3 mb-2 border-b">
        <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground font-sans font-semibold">
          Subjects
        </span>
      </div>

      <div className="space-y-0.5">
        {data.map((node, index) => (
          <FileItem
            key={node.name + index}
            node={node}
            depth={0}
            isLast={index === data.length - 1}
            parentPath={[]}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  )
}
