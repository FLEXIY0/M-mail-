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
    signature_image?: boolean;
    signature_layout?: 'left' | 'above';
    signature_html?: string;
    signature_logo?: boolean;
    signature_logo_height?: number;
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
    require_signature: boolean;

    // Collabora Online is configured: office documents open in the panel.
    office_viewer: boolean;

    // Photos of external senders come from the avatar service of Mail.ru.
    sender_photos: boolean;

    // The job title from the Mattermost profile, for the signature template.
    position?: string;
}

export type WizardMode = 'connect' | 'reconnect' | 'settings' | 'icon';

export type IconAction = 'panel' | 'browser';

export interface IconInfo {
    action: IconAction;
    web_url: string;
    custom_web_url: string;
    default_web_url: string;

    // false: the administrator turned off "the icon opens the web mail".
    browser_allowed: boolean;

    // The user chose the web mail, but the administrator wants the panel.
    forced_panel?: boolean;
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
    delim?: string;
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
    preview?: string;
}

export type MessageFilter = 'unseen' | 'flagged' | 'attachments';

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
    bcc?: Address[];
    reply_to: Address[];
    in_reply_to?: string;
    references?: string[];
    text: string;
    html?: string;
    truncated?: boolean;
    attachments: Attachment[];

    // e-mail → Mattermost user id, for photos of colleagues.
    avatars?: Record<string, string>;
}

export interface MessagePage {
    messages: MessageSummary[];
    total: number;
    unseen: number;
    has_more: boolean;
    avatars?: Record<string, string>;
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
    html?: string;
    reply_to?: MessageRef;
    forward?: MessageRef;
    forward_parts?: string[];
    attachments: OutgoingFile[];
    mattermost_files?: string[];
    signature_image?: boolean;
    signature_logo?: boolean;
    draft_of?: MessageRef;
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

// SortRule puts new mail from a sender (or a whole domain) into a folder.
export interface SortRule {
    id: string;
    from: string;
    folder: string;
    keep_in_inbox: boolean;
    created_at: string;
    applied: number;
    last_error?: string;
}

export interface SortRuleInput {
    id?: string;
    from: string;
    folder: string;
    keep_in_inbox: boolean;
    apply_existing: boolean;
}

export interface ZipEntry {
    index: number;
    name: string;
    size: number;
    dir?: boolean;
    modified: string;
}

export interface EmbeddedMessage {
    subject: string;
    from: Address[];
    to: Address[];
    cc: Address[];
    date: string;
    text: string;
    html?: string;
    attachments: Attachment[];
}

// AttachmentView is what /attachment/view says about a file.
export interface AttachmentView {
    kind: 'text' | 'zip' | 'eml' | 'file';
    filename: string;
    content_type: string;
    size: number;
    text?: string;
    truncated?: boolean;
    entries?: ZipEntry[];
    more?: boolean;
    message?: EmbeddedMessage;
    office?: boolean;
}

// AttachmentRef points to an attachment, or to a file inside a message
// attached to it (sub).
export interface AttachmentRef {
    folder: string;
    uid: number;
    part: string;
    sub?: number;
}

export interface OfficeSession {
    action_url: string;
    access_token: string;
    access_token_ttl: number;
    filename: string;
}

export interface CollaboraCheck {
    collabora_url: string;
    wopi_url: string;
    steps: Array<{title: string; ok: boolean; text: string; warn?: boolean; detail?: string}>;
    alias_line?: string;
    xml?: string;
}

// Contact is someone from the mail history, for suggestions.
export interface Contact {
    email: string;
    name?: string;
    user_id?: string;
    sent: number;
    received: number;
    last: string;
}
