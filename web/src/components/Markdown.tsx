// Agent output is untrusted: Markdown without raw HTML (react-markdown escapes
// it and builds React elements, never innerHTML), safe link targets, and no
// remote images, which would let a page in the sandbox reach the network from
// your browser.
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  img: ({ alt, src }) => <span className="muted">[image: {alt || String(src ?? "")}]</span>,
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
