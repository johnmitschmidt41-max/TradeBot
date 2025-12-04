// Workaround: provide a fallback for JSX intrinsic elements when TS can't resolve react JSX types
// This prevents "Property 'div' does not exist on type 'JSX.IntrinsicElements'" errors.
declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: any;
    }
  }
}

export {};
