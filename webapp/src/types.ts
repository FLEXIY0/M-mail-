export type ProviderID = 'vkworkspace' | 'mailru' | 'yandex' | 'custom';

export type Security = 'tls' | 'starttls' | 'none';

export interface Endpoint {
    host: string;
    port: number;
    security: Security;
}

export interface Provider {
    id: ProviderID;
    name: string;
    imap: Endpoint;
    smtp: Endpoint;
    server_editable: boolean;
    web_url?: string;
    app_password_url?: string;
    help_url?: string;
    domains?: string[];
    recommended?: boolean;
}

export interface Settings {
    notify_new: boolean;
    notify_preview: boolean;
    mark_read_on_open: boolean;
    load_images: boolean;
    signature: string;
}

export interface PluginConfig {
    providers: Provider[];
    default_provider: ProviderID;
    help_text: string;
    email: string;
    display_name: string;
    default_settings: Settings;
    bot_username: string;
    max_attachment_bytes: number;
}

export type WizardMode = 'connect' | 'reconnect' | 'settings' | 'icon';

export type IconAction = 'panel' | 'browser';

export interface IconInfo {
    action: IconAction;
    web_url: string;
    custom_web_url: string;
    default_web_url: string;
}

export interface SyncInfo {
    last_success?: string;
    last_attempt?: string;
    error_code?: string;
    error_message?: string;
    error_details?: string;
    auth_failed?: boolean;
    unseen: number;
}

export interface Me {
    connected: boolean;
    provider?: ProviderID;
    provider_name?: string;
    username?: string;
    email?: string;
    display_name?: string;
    imap?: Endpoint;
    smtp?: Endpoint;
    web_url?: string;
    settings?: Settings;
    sync?: SyncInfo;
    icon: IconInfo;
}

export interface Address {
    name?: string;
    email: string;
}

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | '';

export interface Folder {
    name: string;
    display: string;
    role?: FolderRole;
    depth: number;
    unseen: number;
    total: number;
    no_select?: boolean;
}

export interface MessageSummary {
    uid: number;
    subject: string;
    from: Address[];
    to: Address[];
    date: string;
    seen: boolean;
    flagged: boolean;
    answered: boolean;
    has_attachments: boolean;
    size: number;
    message_id?: string;
}

export interface Attachment {
    part: string;
    filename: string;
    content_type: string;
    size: number;
    inline?: boolean;
    content_id?: string;
}

export interface Message extends MessageSummary {
    cc: Address[];
    reply_to: Address[];
    in_reply_to?: string;
    references?: string[];
    text: string;
    html?: string;
    truncated?: boolean;
    attachments: Attachment[];
}

export interface MessagePage {
    messages: MessageSummary[];
    total: number;
    unseen: number;
    has_more: boolean;
}

export interface MessageRef {
    folder: string;
    uid: number;
}

export interface Recipient {
    name?: string;
    email?: string;
    user_id?: string;
}

export interface OutgoingFile {
    filename: string;
    content_type: string;
    data: string; // base64
}

export interface SendRequest {
    to: Recipient[];
    cc: Recipient[];
    bcc: Recipient[];
    subject: string;
    text: string;
    reply_to?: MessageRef;
    forward?: MessageRef;
    forward_parts?: string[];
    attachments: OutgoingFile[];
    mattermost_files?: string[];
}

export interface CheckResult {
    imap: Endpoint;
    smtp: Endpoint;
    folders: number;
    unseen: number;
    total: number;
}

export interface MattermostUser {
    id: string;
    username: string;
    display_name: string;
    email?: string;
}

export interface UpdateInfo {
    current: string;
    latest?: string;
    name?: string;
    notes?: string;
    url?: string;
    published_at?: string;
    asset?: string;
    asset_url?: string;
    update_available: boolean;
    uploads_enabled: boolean;
    source: string;
    check_error?: string;
}
