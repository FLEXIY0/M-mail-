import manifest from 'manifest';

import type {
    CheckResult, Endpoint, Folder, IconAction, IconInfo, MattermostUser, Me, Message,
    MessagePage, PluginConfig, SendRequest, Settings, SortRule, SortRuleInput, UpdateInfo,
} from './types';

export class ApiError extends Error {
    code: string;
    details: string;
    status: number;

    constructor(code: string, message: string, details: string, status: number) {
        super(message);
        this.code = code;
        this.details = details;
        this.status = status;
    }
}

declare global {
    interface Window {
        basename?: string;
    }
}

function baseUrl() {
    return `${window.basename || ''}/plugins/${manifest.id}/api/v1`;
}

function csrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)MMCSRF=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
}

async function request<T>(method: string, path: string, body?: unknown, absolute = false): Promise<T> {
    const headers: Record<string, string> = {
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
    };
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
    }
    const token = csrfToken();
    if (token) {
        headers['X-CSRF-Token'] = token;
    }

    let response: Response;
    try {
        response = await fetch((absolute ? `${window.basename || ''}` : baseUrl()) + path, {
            method,
            headers,
            credentials: 'include',
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch (e) {
        throw new ApiError('offline', 'Нет связи с сервером Mattermost.', String(e), 0);
    }

    let data: any = {};
    try {
        data = await response.json();
    } catch {
        // Empty or non-JSON body; handled below.
    }
    if (!response.ok) {
        const err = data?.error || {};
        throw new ApiError(err.code || 'unknown', err.message || `Ошибка ${response.status}`, err.details || '', response.status);
    }
    return data as T;
}

export interface CredentialsInput {
    provider: string;
    imap?: Partial<Endpoint>;
    smtp?: Partial<Endpoint>;
    username: string;
    password: string;
}

const q = (params: Record<string, string | number | undefined>) => {
    const parts = Object.entries(params).
        filter(([, v]) => v !== undefined && v !== '').
        map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
    return parts.length ? `?${parts.join('&')}` : '';
};

// attachmentUrl downloads a file through the plugin; the browser sends the
// session cookie, so no token is needed in the address.
export function attachmentUrl(folder: string, uid: number, part: string, inline = false) {
    return `${baseUrl()}/attachment${q({folder, uid, part, inline: inline ? 1 : undefined})}`;
}

// signatureImageUrl shows the stored signature picture; the version
// parameter defeats the browser cache after it is replaced.
export function signatureImageUrl(version: number | string = '') {
    return `${baseUrl()}/signature-image${q({v: version})}`;
}

export const api = {
    config: () => request<PluginConfig>('GET', '/config'),
    me: () => request<Me>('GET', '/me'),
    check: (creds: CredentialsInput) => request<CheckResult>('POST', '/check', creds),
    connect: (creds: CredentialsInput, email: string, displayName: string, settings: Settings) =>
        request<Me>('POST', '/connect', {...creds, email, display_name: displayName, settings}),
    saveSettings: (displayName: string, settings: Settings) =>
        request<Me>('PUT', '/settings', {display_name: displayName, settings}),
    disconnect: () => request<Me>('POST', '/disconnect'),
    savePreferences: (iconAction: IconAction, webUrl: string) =>
        request<IconInfo>('PUT', '/preferences', {icon_action: iconAction, web_url: webUrl}),
    sync: () => request<Me>('POST', '/sync'),
    updateInfo: (refresh: boolean) => request<UpdateInfo>('GET', `/admin/update${refresh ? '?refresh=1' : ''}`),

    folders: () => request<{folders: Folder[]}>('GET', '/folders'),
    messages: (folder: string, offset: number, query = '', filter = '') =>
        request<MessagePage>('GET', `/messages${q({folder, offset, q: query || undefined, filter: filter || undefined})}`),
    message: (folder: string, uid: number, peek = false) =>
        request<Message>('GET', `/message${q({folder, uid, peek: peek ? 1 : undefined})}`),
    setFlag: (folder: string, uids: number[], flag: 'seen' | 'flagged', value: boolean) =>
        request<{ok: boolean}>('POST', '/flags', {folder, uids, flag, value}),
    move: (folder: string, uids: number[], target: {to?: string; role?: string}) =>
        request<{ok: boolean}>('POST', '/move', {folder, uids, ...target}),
    remove: (folder: string, uids: number[]) =>
        request<{ok: boolean; permanent: boolean}>('POST', '/delete', {folder, uids}),
    send: (req: SendRequest) => request<{ok: boolean; message_id: string}>('POST', '/send', req),
    saveDraft: (req: SendRequest) => request<{ok: boolean; folder: string; uid: number}>('POST', '/drafts', req),

    createFolder: (name: string, parent = '') => request<{ok: boolean; name: string}>('POST', '/folders/create', {name, parent}),
    renameFolder: (name: string, newName: string) => request<{ok: boolean; name: string}>('POST', '/folders/rename', {name, new_name: newName}),
    deleteFolder: (name: string) => request<{ok: boolean}>('POST', '/folders/delete', {name}),
    readAll: (folder: string) => request<{ok: boolean}>('POST', '/folders/read', {folder}),
    emptyFolder: (folder: string) => request<{ok: boolean}>('POST', '/folders/empty', {folder}),

    rules: () => request<{rules: SortRule[]}>('GET', '/rules'),
    saveRule: (rule: SortRuleInput) =>
        request<{ok: boolean; rule: SortRule; rules: SortRule[]; sorted: number; moved: number}>('POST', '/rules', rule),
    deleteRule: (id: string) => request<{ok: boolean; rules: SortRule[]}>('POST', '/rules/delete', {id}),

    saveSignatureImage: (dataUrl: string) => request<Me>('PUT', '/signature-image', {data_url: dataUrl}),
    deleteSignatureImage: () => request<Me>('POST', '/signature-image/delete'),

    share: (folder: string, uid: number, channelId: string, rootId: string, comment: string, withFile: boolean) =>
        request<{ok: boolean; post_id: string}>('POST', '/share', {folder, uid, channel_id: channelId, root_id: rootId, comment, with_file: withFile}),

    // Mattermost's own search runs as the current user: it matches first and
    // last names and respects the server's privacy settings. The e-mail of a
    // colleague is filled in by the plugin when the message is sent.
    searchUsers: async (term: string): Promise<{users: MattermostUser[]}> => {
        const users = await request<Array<Record<string, any>>>('POST', '/api/v4/users/search', {term, allow_inactive: false, limit: 10}, true);
        return {
            users: users.
                filter((u) => !u.is_bot && !u.delete_at).
                map((u) => ({
                    id: u.id,
                    username: u.username,
                    display_name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.nickname || u.username,
                    email: u.email || undefined,
                })),
        };
    },
};
