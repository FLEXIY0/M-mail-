import React from 'react';

import {api} from './api';
import type {Me, MessageRef, PluginConfig, Recipient, WizardMode} from './types';

// A tiny global store shared by the panel, the wizard and websocket
// handlers. Mattermost's own Redux store is left alone on purpose: plugin
// reducers are optional and awkward, and this state is private to the plugin.

// ComposeRequest opens the composer: a new message, a reply or a forward.
export interface ComposeRequest {
    mode: 'new' | 'reply' | 'reply_all' | 'forward';
    source?: MessageRef;
    to?: Recipient[];
    subject?: string;
    text?: string;
    mattermostFiles?: Array<{id: string; name: string; size: number}>;
}

export interface State {
    me: Me | null;
    config: PluginConfig | null;
    loading: boolean;
    loadError: string;
    wizard: WizardMode | null;
    compose: ComposeRequest | null;
    share: MessageRef | null;

    // Set by "Open" in a notification: the panel shows this message.
    openRequest: (MessageRef & {nonce: number}) | null;

    // Incremented whenever the mailbox may have changed on the server.
    revision: number;
}

let state: State = {
    me: null,
    config: null,
    loading: false,
    loadError: '',
    wizard: null,
    compose: null,
    share: null,
    openRequest: null,
    revision: 0,
};

const listeners = new Set<() => void>();

export function getState(): State {
    return state;
}

export function setState(patch: Partial<State>) {
    state = {...state, ...patch};
    listeners.forEach((l) => l());
}

export function useStore<T>(selector: (s: State) => T): T {
    const [value, setValue] = React.useState(() => selector(state));
    const selectorRef = React.useRef(selector);
    selectorRef.current = selector;

    React.useEffect(() => {
        const listener = () => setValue(() => selectorRef.current(state));
        listeners.add(listener);
        listener();
        return () => {
            listeners.delete(listener);
        };
    }, []);
    return value;
}

let loadPromise: Promise<void> | null = null;

// loadAll fetches the configuration and the connection state.
export function loadAll(force = false): Promise<void> {
    if (loadPromise && !force) {
        return loadPromise;
    }
    setState({loading: true, loadError: ''});
    loadPromise = Promise.all([api.config(), api.me()]).
        then(([config, me]) => {
            setState({config, me, loading: false});
        }).
        catch((e: Error) => {
            setState({loading: false, loadError: e.message});
            loadPromise = null;
        });
    return loadPromise;
}

export async function refreshMe() {
    try {
        const me = await api.me();
        setState({me});
    } catch {
        // Keep the previous state; the panel shows its own errors.
    }
}

export function openWizard(mode: WizardMode) {
    loadAll();
    setState({wizard: mode});
}

export function closeWizard() {
    setState({wizard: null});
}

export function openCompose(request: ComposeRequest) {
    loadAll();
    setState({compose: request});
}

export function closeCompose() {
    setState({compose: null});
}

export function openShare(ref: MessageRef) {
    setState({share: ref});
}

export function closeShare() {
    setState({share: null});
}

// mailChanged makes the panel reload the folders and the list.
export function mailChanged() {
    setState({revision: state.revision + 1});
}

// The Mattermost Redux store, for reading the current channel and posts.
let reduxStore: {getState: () => any} | null = null;

export function setReduxStore(store: {getState: () => any}) {
    reduxStore = store;
}

export function getReduxState(): any {
    return reduxStore?.getState() || {};
}

// Set by index.tsx once the right-hand sidebar component is registered.
let showPanel: () => void = () => {};

export function setShowPanel(fn: () => void) {
    showPanel = fn;
}

export function openPanel() {
    showPanel();
}

export function openMessage(ref: MessageRef) {
    setState({openRequest: {...ref, nonce: Date.now()}});
    showPanel();
}

// openInBrowser opens a web page outside Mattermost. The desktop app hands
// such links to the default browser, the web app opens a new tab.
export function openInBrowser(url: string) {
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (win) {
        win.opener = null;
    }
}
