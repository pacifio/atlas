/**
 * An HTML file rendered as a page.
 *
 * It runs in a sandboxed frame with an opaque origin and no scripts, so a page
 * can reach neither the app's session nor its storage nor `invoke()`. The
 * markup is handed over as `srcdoc`: the app's CSP refuses framed URLs
 * (`frame-src 'none'`), and a `srcdoc` document inherits that CSP, so scripts
 * and remote resources stay off as well. What renders is the page's markup and
 * its inline styles, which is what a glance at a page needs.
 */
export function HtmlPreview(props: { readonly html: string; readonly title: string }) {
  return (
    <iframe
      title={props.title}
      srcDoc={props.html}
      sandbox=""
      referrerPolicy="no-referrer"
      // A page with no background of its own is drawn on a light canvas, as a
      // browser would draw it, not on the app's surface.
      className="min-h-0 w-full flex-1 border-0 [color-scheme:light]"
    />
  );
}
