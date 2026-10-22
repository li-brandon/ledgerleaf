/**
 * Plaid Link in the browser. The Link script is loaded from Plaid's CDN only when the user
 * clicks "Connect a bank", never at startup.
 */

export const PLAID_LINK_SRC = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

export interface PlaidLinkInstitution {
  institution_id?: string;
  name?: string;
}

export interface PlaidLinkError {
  error_code?: string;
  error_message?: string;
  display_message?: string | null;
}

interface PlaidLinkHandler {
  open(): void;
  destroy(): void;
}

/** The part of `window.Plaid` the app uses. */
export interface PlaidLinkFactory {
  create(config: {
    token: string;
    onSuccess(publicToken: string, metadata: { institution?: PlaidLinkInstitution | null }): void;
    onExit(error: PlaidLinkError | null, metadata: unknown): void;
  }): PlaidLinkHandler;
}

declare global {
  interface Window {
    Plaid?: PlaidLinkFactory;
  }
}

let loading: Promise<PlaidLinkFactory> | undefined;

/** Load the Link script once; a failed load can be retried. */
export function loadPlaidLink(): Promise<PlaidLinkFactory> {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  loading ??= new Promise<PlaidLinkFactory>((done, fail) => {
    const script = document.createElement('script');
    script.src = PLAID_LINK_SRC;
    script.async = true;
    script.onload = () => (window.Plaid ? done(window.Plaid) : fail(new Error('Plaid Link did not load.')));
    script.onerror = () => {
      script.remove();
      fail(new Error('Could not load Plaid Link. Check your internet connection.'));
    };
    document.head.append(script);
  }).catch((e) => {
    loading = undefined;
    throw e;
  });
  return loading;
}

export interface LinkSuccess {
  publicToken: string;
  institution: PlaidLinkInstitution | null;
}

/**
 * Open Link with `token`. Resolves with the public token once the user connects a bank,
 * with null if they close Link, and rejects if Link reports an error.
 */
export async function openPlaidLink(token: string): Promise<LinkSuccess | null> {
  const Plaid = await loadPlaidLink();
  return new Promise((done, fail) => {
    const handler = Plaid.create({
      token,
      onSuccess: (publicToken, metadata) => {
        handler.destroy();
        done({ publicToken, institution: metadata?.institution ?? null });
      },
      onExit: (error) => {
        handler.destroy();
        if (error) fail(new Error(error.display_message || error.error_message || 'Plaid Link failed.'));
        else done(null);
      },
    });
    handler.open();
  });
}
