import type { ComponentPropsWithoutRef, FC } from "react";
import { HairlineRule } from "../../../components/layout";

/**
 * Body paragraph — Geist sans, 17px / 1.7 leading / 68ch measure.
 * Tuned for sustained 600+ word section reading.
 */
export const P: FC<ComponentPropsWithoutRef<"p">> = ({ children, ...rest }) => (
  <p className="font-sans text-[17px] leading-[1.7] text-ink max-w-[68ch] mb-6" {...rest}>
    {children}
  </p>
);

/**
 * Hyperlink. External (`http://` / `https://`) opens in a new tab
 * with `noopener noreferrer`; internal (relative or anchor) stays
 * same-tab. Hairline-underline that warms to ink on hover, matching
 * the v3 paper aesthetic instead of the default browser blue.
 */
export const A: FC<ComponentPropsWithoutRef<"a">> = ({ children, href, ...rest }) => {
  const isExternal = !!href && (href.startsWith("http://") || href.startsWith("https://"));
  return (
    <a
      href={href}
      className="text-ink underline decoration-rule decoration-1 underline-offset-[3px] transition-colors duration-300 ease-opta hover:decoration-ink"
      {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      {...rest}
    >
      {children}
    </a>
  );
};

/**
 * Strong — Geist 600. Adds visual weight without leaving the body
 * register (which would jar against surrounding sans prose).
 */
export const Strong: FC<ComponentPropsWithoutRef<"strong">> = ({ children, ...rest }) => (
  <strong className="font-semibold text-ink" {...rest}>
    {children}
  </strong>
);

/**
 * Emphasis — Inter italic. Body em sits at 17px which is below the
 * 18px Fraunces floor; Inter italic stays readable at sustained reading
 * sizes where Fraunces text-axis goes spindly.
 */
export const Em: FC<ComponentPropsWithoutRef<"em">> = ({ children, ...rest }) => (
  <em className="font-sans italic" {...rest}>
    {children}
  </em>
);

/**
 * Blockquote — hairline left rule, Inter italic, narrower measure.
 * Body-size copy stays Inter italic; reserve Fraunces for ≥18px.
 */
export const Blockquote: FC<ComponentPropsWithoutRef<"blockquote">> = ({ children, ...rest }) => (
  <blockquote
    className="border-l-2 border-rule pl-6 my-8 font-sans italic text-ink/85 max-w-[60ch]"
    {...rest}
  >
    {children}
  </blockquote>
);

/** hr — renders through the brand's HairlineRule primitive. */
export const Hr: FC = () => <HairlineRule className="my-12" />;
