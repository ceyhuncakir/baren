/**
 * Input schemas, titles, descriptions and annotations of every MCP tool (contract §6). Every
 * schema is a strict zod object (JSON schema `additionalProperties: false`). `fileId` is
 * optional everywhere.
 */
import { z } from 'zod'
import type { McpToolName } from '../../../renderer/types/bridge'

/** The types a design token can have. */
export const TOKEN_TYPES = [
  'breakpoint',
  'color',
  'container',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'opacity',
  'radius',
  'spacing',
] as const

export const EXPORT_FORMATS = ['avif', 'jpg', 'mp4', 'pdf', 'png', 'svg', 'webm', 'webp'] as const
export const SCALE_PATTERN = /^\d+(\.\d+)?(x|w|h|p)$/
const TOKEN_NAME = /^--[a-zA-Z0-9_-]+$/

const fileId = z
  .string()
  .describe(
    'File ID or URL. Optional: defaults to the file the user is looking at (call list_files for others).',
  )
  .optional()
const pageId = z.string().describe('Page ID. Optional: defaults to the page the user is viewing.')
const nodeId = z.string().describe('Node ID')
const styleValue = z.union([z.string(), z.number()])

export const schemas = {
  get_guide: z.strictObject({
    topic: z
      .string()
      .describe(
        'Guide topic: "baren-mcp-instructions", "mobile-status-bar", "images", "code-export" or "image-generation".',
      ),
  }),
  get_basic_info: z.strictObject({ fileId, pageId: pageId.optional() }),
  list_files: z.strictObject({
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('At most this many files (default 50).'),
  }),
  open_file: z.strictObject({
    fileId: z.string().min(1).describe('File ID or URL to open.'),
    pageId: pageId.optional(),
  }),
  create_file: z.strictObject({
    name: z.string().max(1024).optional().describe('File name (default "Untitled").'),
    cloneFileId: z.string().optional().describe('Copy this file instead of starting empty.'),
  }),
  create_page: z.strictObject({
    fileId,
    name: z.string().max(1024).optional().describe('Page name (default "Page N").'),
  }),
  rename_pages: z.strictObject({
    fileId,
    updates: z.array(z.object({ pageId: z.string(), name: z.string().min(1).max(1024) })).min(1),
  }),
  get_selection: z.strictObject({ fileId }),
  get_tree_summary: z.strictObject({
    fileId,
    nodeId,
    depth: z.number().describe('Levels to include, 1–10 (default 3).').optional(),
  }),
  get_children: z.strictObject({ fileId, nodeId }),
  get_node_info: z.strictObject({ fileId, nodeId }),
  find_nodes: z.strictObject({
    fileId,
    filters: z
      .array(
        z.object({
          styleName: z
            .string()
            .optional()
            .describe('CSS property (camelCase or kebab-case); "*" matches any.'),
          styleValue: z
            .string()
            .optional()
            .describe(
              'A literal ("#ff0000", "16px") or a token ("--color-primary"); "*" wildcards.',
            ),
        }),
      )
      .min(1)
      .optional(),
    textValue: z
      .string()
      .optional()
      .describe('Text layer content, case-insensitive, "*" wildcards.'),
    nodeId: z.string().optional().describe('Search this node and its descendants.'),
    pageId: z.string().optional().describe('Search one page (default: every page).'),
  }),
  get_jsx: z.strictObject({
    fileId,
    nodeId,
    format: z.enum(['tailwind', 'inline-styles']).optional().describe('Default "tailwind".'),
    includeIds: z.boolean().optional().describe('Add data-node-id attributes (default false).'),
  }),
  get_computed_styles: z.strictObject({
    fileId,
    nodeIds: z.array(z.string()).min(1).max(200),
    resolved: z
      .boolean()
      .optional()
      .describe('true: values the browser computes (tokens resolved, sizes in px).'),
  }),
  get_screenshot: z.strictObject({
    fileId,
    nodeId,
    scale: z.number().describe('0.1–4 (default 1).').optional(),
  }),
  get_fill_image: z.strictObject({ fileId, nodeId }),
  get_font_family_info: z.strictObject({
    familyNames: z.array(z.string()).min(1).max(20),
  }),
  get_tokens: z.strictObject({
    fileId,
    format: z.enum(['json', 'css', 'tailwind']).optional().describe('Default "json".'),
    namePattern: z
      .string()
      .optional()
      .describe('Glob on the full variable name, e.g. "--color-*".'),
    types: z.array(z.enum(TOKEN_TYPES)).optional(),
  }),
  create_tokens: z.strictObject({
    fileId,
    tokens: z
      .array(
        z.object({
          type: z.enum(TOKEN_TYPES),
          name: z.string().regex(TOKEN_NAME),
          value: styleValue,
          description: z.string().max(1024).optional(),
        }),
      )
      .min(1),
  }),
  set_tokens: z.strictObject({
    fileId,
    tokens: z
      .array(
        z.object({
          name: z.string().regex(TOKEN_NAME),
          newName: z.string().regex(TOKEN_NAME).optional(),
          value: styleValue.optional(),
          description: z.string().max(1024).optional(),
          delete: z.boolean().optional(),
        }),
      )
      .min(1),
  }),
  create_artboard: z.strictObject({
    fileId,
    name: z.string().describe('Artboard name.'),
    pageId: pageId.optional(),
    styles: z
      .object({
        width: z.string().describe('Whole px, e.g. "1440px".'),
        height: z.string().describe('Whole px or "fit-content".'),
      })
      .catchall(styleValue)
      .describe('CSS styles (camelCase); width and height are required.'),
  }),
  write_html: z.strictObject({
    fileId,
    html: z.string().min(1).max(1_048_576).describe('HTML with inline styles.'),
    mode: z.enum(['insert-children', 'replace']),
    targetNodeId: z.string().describe('The parent (insert-children) or the node to replace.'),
  }),
  update_styles: z.strictObject({
    fileId,
    updates: z
      .array(
        z.object({
          nodeIds: z.array(z.string()).min(1),
          styles: z
            .record(z.string(), z.union([z.string(), z.number(), z.null()]))
            .describe('camelCase CSS properties; null or "" removes one.'),
        }),
      )
      .min(1),
  }),
  set_text_content: z.strictObject({
    fileId,
    updates: z.array(z.object({ nodeId: z.string(), textContent: z.string().max(100_000) })).min(1),
  }),
  rename_nodes: z.strictObject({
    fileId,
    updates: z.array(z.object({ nodeId: z.string(), name: z.string() })).min(1),
  }),
  duplicate_nodes: z.strictObject({
    fileId,
    nodes: z
      .array(
        z.object({
          id: z.string().describe('Node to duplicate.'),
          parentId: z.string().optional().describe('Add the copy at the end of this parent.'),
        }),
      )
      .min(1),
  }),
  move_nodes: z.strictObject({
    fileId,
    moves: z
      .array(
        z.union([
          z.strictObject({ nodeId: z.string(), before: z.string() }),
          z.strictObject({ nodeId: z.string(), after: z.string() }),
          z.strictObject({
            nodeId: z.string(),
            parentId: z.string().describe('Parent ID, or "root" for the page the node is on.'),
            index: z.number().int().min(0).optional(),
          }),
        ]),
      )
      .min(1),
  }),
  delete_nodes: z.strictObject({
    fileId,
    nodeIds: z.array(z.string()).min(1),
  }),
  finish_working_on_nodes: z.strictObject({
    fileId: z
      .string()
      .describe(
        'File ID or URL. Optional: without it (and without nodeIds) every file is released.',
      )
      .optional(),
    nodeIds: z.array(z.string()).optional().describe('Artboards (or nodes in them) you finished.'),
  }),
  export: z.strictObject({
    fileId,
    pageId: z.string().optional(),
    type: z.enum(['image', 'video']).optional(),
    nodes: z.union([
      z.literal('nodes-with-exports-only'),
      z.record(
        z.string(),
        z.array(
          z.object({
            format: z.enum(EXPORT_FORMATS),
            scale: z
              .string()
              .regex(SCALE_PATTERN)
              .describe('"2x" multiplier, "800w" width, "600h" height or "512p" shortest side.'),
            durationSeconds: z.number().min(1).max(300).optional(),
            pdfQuality: z.enum(['low', 'medium', 'high']).optional(),
            pdfResampling: z.enum(['detailed', 'basic']).optional(),
          }),
        ),
      ),
    ]),
  }),
} satisfies Record<McpToolName, z.ZodObject>

export type ToolSchemas = typeof schemas
export type ToolArgs<K extends McpToolName> = z.output<ToolSchemas[K]>

export type ToolKind = 'read' | 'write'

export interface ToolMeta {
  title: string
  kind: ToolKind
  description: string
  destructive?: boolean
}

const WRITE_HTML_DESCRIPTION = `Write HTML into the design as new layers. mode "insert-children" adds the HTML as the last children of targetNodeId (a page, frame or group); mode "replace" removes targetNodeId and puts the new layers in its place.
IMPORTANT: Write incrementally. The user watches you write on the canvas in real time; show visual progress every few seconds. Each call should create one visual item: a header, one list row, a button bar or a paragraph block. Even a simple card is several calls: the shell, then the header, then each row, then the footer.
IMPORTANT: Prefer cloning existing layers over rewriting them: <x-baren-clone node-id="…" style="…" /> copies a layer and applies your inline styles to the copy. For repeated items, create the container first, then add each item in its own call, or duplicate the first one with duplicate_nodes.

HTML and CSS rules:
- Inline styles only (style="…"); class and <style> are ignored. Use the file's design tokens as CSS variables.
- Name layers with the layer-name attribute, e.g. <div layer-name="Hero">.
- Flexbox is the layout system: display flex, gap and padding. Do NOT use margin, display: inline, display: grid or HTML tables.
- position: absolute is fully supported; use it for decorative elements, never to cover a whole artboard (it blocks clicks underneath).
- Everything is border-box. display: block is fine for simple leaves (text, shapes), not for layout containers.
- An element that contains only text becomes one text layer. Rich text is not supported: put differently styled runs in separate elements. Use <pre> or white-space: pre for code and indented text.
- Any CSS colour format works: hex, rgb(a), hsl(a), oklch, oklab, color-mix().
- Icons: inline <svg>; fill and stroke may use var(--token) and currentColor. Never use emoji as icons.
- Images: <img src> with an absolute local path, an https URL, a data URI or baren-asset://<hash> (get_guide topic "images"). AI image generation is not available.
- Fonts: Inter, JetBrains Mono and every Google Fonts family render the same for every collaborator; other installed fonts work on this computer only (get_font_family_info).
The result lists the created layers and warnings for anything that was dropped or changed.`

/** Titles, kinds and the exact descriptions of contract §6. */
export const TOOL_META: Record<McpToolName, ToolMeta> = {
  get_guide: {
    title: 'Get guide',
    kind: 'read',
    description:
      'Read a detailed guide on a topic. Call with topic "baren-mcp-instructions" before using other Baren tools. Other topics: "mobile-status-bar" (paste-ready status bar markup for phone artboards), "images" (how to put images into a design), "code-export" (turning designs into code), "image-generation".',
  },
  get_basic_info: {
    title: 'Get basic file info',
    kind: 'read',
    description:
      'Get essential context about a design file: file name, the page, node count, artboards with their sizes and positions, pages, font families in use, design tokens and components. Call it first. Without fileId the file the user is looking at is used; without pageId the page they are viewing. worldX/worldY/width/height are null when they depend on layout and the node has not been measured. Pass pageId to work on another page without disturbing the user.',
  },
  list_files: {
    title: 'List files',
    kind: 'read',
    description:
      'List Baren files on this computer: files open in the app first, then the most recently updated. isShared marks files shared with a team.',
  },
  open_file: {
    title: 'Open file',
    kind: 'read',
    description:
      "Open a file in the Baren app by its ID or URL, so the user sees it. pageId is applied only when the file is not open yet (the user's current page is never changed). Returns the same information as get_basic_info.",
  },
  create_file: {
    title: 'Create file',
    kind: 'write',
    description:
      'Create a new local Baren file and return its ID. Optionally clone an existing file. The file is not opened: pass the ID as fileId to other tools (works without opening it), or call open_file to show it to the user.',
  },
  create_page: {
    title: 'Create page',
    kind: 'write',
    description:
      "Create a new page in the file and return its ID. Use the pageId in later calls to work on it; the user's current page does not change.",
  },
  rename_pages: {
    title: 'Rename pages',
    kind: 'write',
    description: 'Rename one or more pages. Does not change which page the user is viewing.',
  },
  get_selection: {
    title: 'Get selection',
    kind: 'read',
    description:
      'Get the layers the user has selected in the file they are looking at: IDs, names, component types, sizes and the artboard each belongs to.',
  },
  get_tree_summary: {
    title: 'Get tree summary',
    kind: 'read',
    description:
      "Get a compact text outline of a node's subtree: component type, name, ID and size of each layer, and text content. Sizes show '?' when they depend on layout and have not been measured. Much cheaper than get_jsx — use it to understand structure first. depth defaults to 3 (max 10).",
  },
  get_children: {
    title: 'Get children',
    kind: 'read',
    description:
      'Get the direct children of a node with their IDs, names, component types, child counts, world position (worldX/worldY) and position relative to the parent (x/y). Positions are null when they depend on layout and have not been measured.',
  },
  get_node_info: {
    title: 'Get node info',
    kind: 'read',
    description:
      'Get detailed information about a node: size, position, visibility, lock state, parent, children, the artboard it belongs to, text content, image and component information. x/y/worldX/worldY/width/height are null when they depend on layout and the node has not been measured.',
  },
  find_nodes: {
    title: 'Find nodes',
    kind: 'read',
    description:
      'Find nodes by style and/or text content — for example everything that uses a token, a literal colour or a piece of copy before a bulk update. Searches every page by default; pass pageId to search one page, or nodeId to search a node and its descendants (nodeId wins). filters are { styleName, styleValue } matchers combined with AND; both accept "*" wildcards; styleValue may be a literal ("#ff0000", "16px") or a token ("--color-primary"). Colours match by equivalence, and a literal colour also finds token-bound usages (reported as the var(--token) reference). textValue matches text layer content, case-insensitive, with "*" wildcards anchored to the whole value ("Submit", "Get *", "*started*"). Each result has its ID, name, component and the matched entries; for a colour inside a gradient, border or shadow, styleValue is the matched fragment.',
  },
  get_jsx: {
    title: 'Get JSX',
    kind: 'read',
    description:
      'Get the JSX code of a node and its descendants. format "tailwind" (default) uses Tailwind classes mapped to the file\'s design tokens with inline fallbacks; "inline-styles" uses React style objects. The output is deterministic.',
  },
  get_computed_styles: {
    title: 'Get computed styles',
    kind: 'read',
    description:
      'Get the CSS styles of one or more nodes as a map of nodeId to CSS properties (camelCase). Values are the styles as designed, with design tokens kept as var(--…). Pass resolved: true to get the values the browser computes instead (tokens resolved, sizes in px). Supports batches.',
  },
  get_screenshot: {
    title: 'Get screenshot',
    kind: 'read',
    description:
      "Capture a screenshot of a node by ID (JPEG). 1x scale (default) is enough to check layout, spacing and colour; use scale 2 only to read small text. Large images are downscaled to fit size limits — screenshot a child node for more detail. The node is rendered on its own, independent of what the user's canvas shows.",
  },
  get_fill_image: {
    title: 'Get fill image',
    kind: 'read',
    description:
      'Get the image of a node that has an image (an image layer or an image fill) as JPEG, resized to fit size limits, with its asset ID, type and natural size. Returns an error if the node has no image; for SVG and vector layers use get_jsx.',
  },
  get_font_family_info: {
    title: 'Get font family info',
    kind: 'read',
    description:
      'Check whether font families are available and which weights and styles they have. Call before your first typographic styling. Inter and JetBrains Mono are bundled and Google Fonts families are downloaded, so they render the same for every collaborator; other installed fonts work on this computer only.',
  },
  get_tokens: {
    title: 'Get tokens',
    kind: 'read',
    description:
      'List the file\'s design tokens (colours, spacing, typography, radius…). format "json" (default) returns structured tokens, "css" a :root { … } stylesheet, "tailwind" a Tailwind v4 @theme { … } block. Filter with namePattern (a glob on the full variable name, e.g. "--color-*") and types.',
  },
  create_tokens: {
    title: 'Create tokens',
    kind: 'write',
    description:
      'Create one or more design tokens. Each entry needs type, name (a CSS custom property such as "--color-primary") and value; use var(--other-token) as the value to alias another token. Returns one result per entry ({ name, result: "created" } or an error, e.g. when the name already exists — change existing tokens with set_tokens). Order matters: define colour tokens semantic first (neutrals, then primary, secondary, accents); define other types from the smallest value to the largest. Reuse existing tokens before creating new ones.',
  },
  set_tokens: {
    title: 'Set tokens',
    kind: 'write',
    description:
      'Update, rename or delete existing design tokens by their full CSS variable name. Each entry needs name; newName renames the token (references to it across the file are updated), value changes its value (var(--other-token) makes an alias), description changes its description ("" clears it), delete: true removes it. Entries are applied in order; errors are reported per entry.',
  },
  create_artboard: {
    title: 'Create artboard',
    kind: 'write',
    description:
      'Create a new artboard (top-level frame) on a page and return its ID; then add content with write_html (mode "insert-children"). Set the size with styles (width and height in whole px are required). Artboards default to display: flex, flexDirection: column and a white background. Without left/top it is placed in a free spot next to the other artboards. Omit pageId to use the page the user is viewing. Default sizes: desktop 1440×900, tablet 768×1024, phone 390×844 (with a status bar: get_guide topic "mobile-status-bar"). The height is a starting point: when content clips, set height "fit-content" with update_styles instead of guessing.',
  },
  write_html: {
    title: 'Write HTML',
    kind: 'write',
    destructive: true,
    description: WRITE_HTML_DESCRIPTION,
  },
  update_styles: {
    title: 'Update styles',
    kind: 'write',
    description:
      'Update styles on one or more nodes in one call. styles is a JSON object with camelCase CSS property names, like React.CSSProperties ({ "backgroundColor": "var(--color-surface)", "padding": "20px" }); pass null or an empty string to remove a property. Design tokens work as CSS variables. Setting left/top on an artboard moves it on the canvas. Styles that are inert in a node\'s context (e.g. gap on an image) are dropped rather than applied and returned under ignoredStyles; anything else dropped or changed is listed in warnings. Layers inside a component instance get the change as an override.',
  },
  set_text_content: {
    title: 'Set text content',
    kind: 'write',
    description:
      'Set the text of one or more text layers (component "Text") in one call. Use this instead of write_html replace when only the text changes. Text inside a component instance becomes an override.',
  },
  rename_nodes: {
    title: 'Rename nodes',
    kind: 'write',
    description:
      'Rename one or more layers (the names shown in the layers panel). Names longer than 50 characters are truncated. Supports batches. Use rename_pages for pages.',
  },
  duplicate_nodes: {
    title: 'Duplicate nodes',
    kind: 'write',
    description:
      'Duplicate one or more nodes with all their descendants. Without parentId the copy goes right after its source in the same parent; with parentId it is added at the end of that parent. Duplicated artboards are placed in a free spot next to their source. Returns the source and new IDs plus descendantIdMap, which maps every descendant ID of a source to its copy — use it to edit the copies right away (e.g. set_text_content) without looking them up.',
  },
  move_nodes: {
    title: 'Move nodes',
    kind: 'write',
    description:
      'Move existing nodes — reorder or reparent — keeping their IDs, so references you hold stay valid. Prefer this over duplicate + delete or rewriting HTML. Each move is either sibling-relative ({ nodeId, before } or { nodeId, after }: the parent comes from the sibling) or parent-absolute ({ nodeId, parentId, index? }: index is the final position among the new siblings, clamped, appended when omitted; parentId "root" means the page the node is on). Moves apply in order and see the earlier ones. In flex parents this changes the visual order; in other parents it changes stacking and keeps the node\'s position on the canvas. Baren adjusts position styles (absolute/flow) so the node keeps its place, and may fix its size when it leaves a flex parent. Nodes can move between pages. A node cannot move into itself, into a layer that cannot have children, or into a component instance. Returns the resolved parentId and index of each move and affectedParents: the final child list of every parent whose children changed.',
  },
  delete_nodes: {
    title: 'Delete nodes',
    kind: 'write',
    destructive: true,
    description:
      'Delete one or more nodes and all their descendants. Layers inside a component instance are hidden instead (an override). IMPORTANT: before deleting nodes you think have the wrong parent, check them with get_node_info.',
  },
  finish_working_on_nodes: {
    title: 'Finish working on nodes',
    kind: 'write',
    description:
      'MUST be called when you are done working. Removes your "working" indicator from the artboards you were editing. Call with no nodeIds to release all of them at once, or pass the IDs of the artboards you finished (preferred when several agents work in the file).',
  },
  export: {
    title: 'Export',
    kind: 'write',
    description:
      "Export nodes as image files (png, jpg, webp; svg for vector and SVG layers; pdf) to the user's Downloads folder and return their paths. Unless the user specifies, use the defaults (png at 1x).",
  },
}

export const TOOL_NAMES = Object.keys(TOOL_META) as McpToolName[]

/** MCP annotations (contract §4.3). */
export function annotationsFor(name: McpToolName): {
  readOnlyHint: boolean
  destructiveHint?: boolean
  openWorldHint: false
} {
  const meta = TOOL_META[name]
  if (meta.kind === 'read') return { readOnlyHint: true, openWorldHint: false }
  return { readOnlyHint: false, destructiveHint: meta.destructive === true, openWorldHint: false }
}
