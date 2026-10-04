/**
 * The host's tool table (contract §6, §4.6): every tool a host executes, whether it writes
 * (read-only check, serialised, one commit) and whether its result carries the file header.
 * Comment writes commit with a `comment:` origin instead of `agent:<tool>` (`comments.ts`).
 * Tools main runs itself or orchestrates (get_guide, list_files, create_file, get_screenshot,
 * get_fill_image, get_font_family_info, export, finish_working_on_nodes) are not here.
 */
import type { ToolSpec } from '../context'
import { getComputedStyles, getJsx, getTokensTool } from './code'
import { getComments, replyToComment, resolveComment } from './comments'
import { findNodes } from './find'
import { flush, nodeImageTool, openFile, release, renderJob } from './internal'
import {
  deleteNodesTool,
  duplicateNodesTool,
  moveNodes,
  renameNodes,
  setTextContent,
} from './nodes'
import {
  artboardsOf,
  getBasicInfo,
  getChildren,
  getNodeInfo,
  getSelection,
  getTreeSummary,
} from './read'
import { createTokens, setTokensTool } from './tokens'
import { createArtboard, createPageTool, renamePages, updateStyles, writeHtml } from './write'

export const HOST_TOOLS: Readonly<Record<string, ToolSpec>> = {
  // Reads
  get_basic_info: { run: getBasicInfo, write: false },
  open_file: { run: openFile, write: false },
  get_selection: { run: getSelection, write: false },
  get_tree_summary: { run: getTreeSummary, write: false },
  get_children: { run: getChildren, write: false },
  get_node_info: { run: getNodeInfo, write: false },
  find_nodes: { run: findNodes, write: false },
  get_jsx: { run: getJsx, write: false },
  get_computed_styles: { run: getComputedStyles, write: false },
  get_tokens: { run: getTokensTool, write: false },
  get_comments: { run: getComments, write: false },
  // Writes
  create_page: { run: createPageTool, write: true },
  rename_pages: { run: renamePages, write: true },
  create_tokens: { run: createTokens, write: true },
  set_tokens: { run: setTokensTool, write: true },
  create_artboard: { run: createArtboard, write: true },
  write_html: { run: writeHtml, write: true },
  update_styles: { run: updateStyles, write: true },
  set_text_content: { run: setTextContent, write: true },
  rename_nodes: { run: renameNodes, write: true },
  duplicate_nodes: { run: duplicateNodesTool, write: true },
  move_nodes: { run: moveNodes, write: true },
  delete_nodes: { run: deleteNodesTool, write: true },
  reply_to_comment: { run: replyToComment, write: true },
  resolve_comment: { run: resolveComment, write: true },
  // Internal (main ↔ host)
  release: { run: release, write: false, header: false },
  flush: { run: flush, write: false, header: false },
  // artboards_of and render_job carry the header: get_screenshot and resolved
  // get_computed_styles answer with it (header, then image / body blocks).
  artboards_of: { run: artboardsOf, write: false },
  render_job: { run: renderJob, write: false },
  node_image: { run: nodeImageTool, write: false },
}
