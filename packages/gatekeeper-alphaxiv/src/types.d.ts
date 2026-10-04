/** Read-only discovery and content retrieval for public papers. */
export interface AlphaXivSession {
  discover_papers(input: { keywords: string[]; question?: string }): Promise<string>;
  get_paper_content(input: { url: string; fullText?: boolean }): Promise<string>;
}
