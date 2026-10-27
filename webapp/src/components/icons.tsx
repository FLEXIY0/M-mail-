import React from 'react';

// Small inline icons (24x24 grid, currentColor) so that the plugin does not
// depend on the icon font of a specific Mattermost version.

type IconProps = {size?: number; className?: string};

function Svg({size = 16, className, children}: IconProps & {children: React.ReactNode}) {
    return (
        <svg
            className={className}
            width={size}
            height={size}
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth={2}
            strokeLinecap='round'
            strokeLinejoin='round'
            aria-hidden='true'
        >
            {children}
        </svg>
    );
}

export const CalendarIcon = (p: IconProps) => (
    <Svg {...p}>
        <rect
            x='3'
            y='4.5'
            width='18'
            height='16.5'
            rx='2.5'
        />
        <path d='M3 9.5h18M8 2.5v4M16 2.5v4'/>
        <path d='M7.5 13.5h2M11 13.5h2M14.5 13.5h2M7.5 17h2M11 17h2'/>
    </Svg>
);

export const ChevronLeft = (p: IconProps) => <Svg {...p}><path d='M15 18l-6-6 6-6'/></Svg>;
export const ChevronRight = (p: IconProps) => <Svg {...p}><path d='M9 18l6-6-6-6'/></Svg>;
export const ChevronDown = (p: IconProps) => <Svg {...p}><path d='M6 9l6 6 6-6'/></Svg>;

export const RefreshIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M20 11a8 8 0 1 0-2.3 5.7'/>
        <path d='M20 4v7h-7'/>
    </Svg>
);

export const GearIcon = (p: IconProps) => (
    <Svg {...p}>
        <circle
            cx='12'
            cy='12'
            r='3'
        />
        <path d='M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'/>
    </Svg>
);

export const ExternalIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M14 4h6v6M20 4l-9 9'/>
        <path d='M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'/>
    </Svg>
);

export const VideoIcon = (p: IconProps) => (
    <Svg {...p}>
        <rect
            x='2.5'
            y='6'
            width='13'
            height='12'
            rx='2'
        />
        <path d='M15.5 10.5l6-3.5v10l-6-3.5z'/>
    </Svg>
);

export const PinIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z'/>
        <circle
            cx='12'
            cy='9.5'
            r='2.5'
        />
    </Svg>
);

export const BroomIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M19 4l-7.5 7.5'/>
        <path d='M9.5 10.5l4 4'/>
        <path d='M11.5 12.5c-2 3.5-4.5 6.5-8 7 .5-3.5 3-6 5-7.5z'/>
    </Svg>
);

export const PlusIcon = (p: IconProps) => <Svg {...p}><path d='M12 5v14M5 12h14'/></Svg>;
export const CheckIcon = (p: IconProps) => <Svg {...p}><path d='M5 12.5l4.5 4.5L19 7.5'/></Svg>;
export const CloseIcon = (p: IconProps) => <Svg {...p}><path d='M6 6l12 12M18 6L6 18'/></Svg>;

export const AlertIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'/>
        <path d='M12 9v4M12 17h.01'/>
    </Svg>
);

export const EyeIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z'/>
        <circle
            cx='12'
            cy='12'
            r='3'
        />
    </Svg>
);

export const EyeOffIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M17.9 17.9A10.8 10.8 0 0 1 12 19.5C5.5 19.5 1.5 12 1.5 12a19 19 0 0 1 4.6-5.4M9.9 4.7A9.7 9.7 0 0 1 12 4.5c6.5 0 10.5 7.5 10.5 7.5a19.2 19.2 0 0 1-2.3 3.3M14.1 14.1a3 3 0 1 1-4.2-4.2'/>
        <path d='M1.5 1.5l21 21'/>
    </Svg>
);

export const RepeatIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M17 2l4 4-4 4'/>
        <path d='M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4'/>
        <path d='M21 13v2a3 3 0 0 1-3 3H3'/>
    </Svg>
);

export const UsersIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'/>
        <circle
            cx='9'
            cy='7'
            r='4'
        />
        <path d='M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8'/>
    </Svg>
);

export const CopyIcon = (p: IconProps) => (
    <Svg {...p}>
        <rect
            x='9'
            y='9'
            width='12'
            height='12'
            rx='2'
        />
        <path d='M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'/>
    </Svg>
);

export const BellIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0'/>
    </Svg>
);

export const SunIcon = (p: IconProps) => (
    <Svg {...p}>
        <circle
            cx='12'
            cy='12'
            r='4'
        />
        <path d='M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'/>
    </Svg>
);

export const StatusIcon = (p: IconProps) => (
    <Svg {...p}>
        <circle
            cx='12'
            cy='12'
            r='9'
        />
        <path d='M12 7v5l3 2'/>
    </Svg>
);

export const ShieldIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'/>
        <path d='M9 12l2 2 4-4'/>
    </Svg>
);

export const Spinner = ({size = 16}: {size?: number}) => (
    <span
        className='mml-spinner'
        style={{width: size, height: size}}
        role='status'
        aria-label='Загрузка'
    />
);

export const MailIcon = (p: IconProps) => (
    <Svg {...p}>
        <rect
            x='3'
            y='5'
            width='18'
            height='14'
            rx='2.5'
        />
        <path d='M3.5 7l8.5 6 8.5-6'/>
    </Svg>
);

export const MailOpenIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M3 10l9-6 9 6v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/>
        <path d='M3.5 10.5l8.5 5.5 8.5-5.5'/>
    </Svg>
);

export const InboxIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M3 13l2.5-7.5A2 2 0 0 1 7.4 4h9.2a2 2 0 0 1 1.9 1.5L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/>
        <path d='M3 13h5l1.5 2.5h5L16 13h5'/>
    </Svg>
);

export const SendIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M21 3L10 14'/>
        <path d='M21 3l-7 18-4-7-7-4z'/>
    </Svg>
);

export const DraftIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z'/>
        <path d='M14 3v6h6M8 13h8M8 17h5'/>
    </Svg>
);

export const TrashIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3'/>
    </Svg>
);

export const SpamIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7z'/>
        <path d='M12 8v5M12 16.5v.5'/>
    </Svg>
);

export const ArchiveIcon = (p: IconProps) => (
    <Svg {...p}>
        <rect
            x='3'
            y='4'
            width='18'
            height='5'
            rx='1.5'
        />
        <path d='M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4'/>
    </Svg>
);

export const FolderIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/>
    </Svg>
);

export const ReplyIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M9 14L4 9l5-5'/>
        <path d='M4 9h10.5a5.5 5.5 0 0 1 0 11H11'/>
    </Svg>
);

export const ReplyAllIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M7 14L2 9l5-5'/>
        <path d='M12 14L7 9l5-5'/>
        <path d='M7 9h8.5a5.5 5.5 0 0 1 0 11H13'/>
    </Svg>
);

export const ForwardIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M15 14l5-5-5-5'/>
        <path d='M20 9H9.5a5.5 5.5 0 0 0 0 11H13'/>
    </Svg>
);

export const StarIcon = ({filled, ...p}: IconProps & {filled?: boolean}) => (
    <svg
        className={p.className}
        width={p.size || 16}
        height={p.size || 16}
        viewBox='0 0 24 24'
        fill={filled ? 'currentColor' : 'none'}
        stroke='currentColor'
        strokeWidth={2}
        strokeLinejoin='round'
        aria-hidden='true'
    >
        <path d='M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z'/>
    </svg>
);

export const PaperclipIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9'/>
    </Svg>
);

export const SearchIcon = (p: IconProps) => (
    <Svg {...p}>
        <circle
            cx='11'
            cy='11'
            r='7'
        />
        <path d='M20 20l-4-4'/>
    </Svg>
);

export const DownloadIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M12 4v12M7 11l5 5 5-5M5 20h14'/>
    </Svg>
);

export const ShareIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 15V3M7 8l5-5 5 5'/>
    </Svg>
);

export const ImageIcon = (p: IconProps) => (
    <Svg {...p}>
        <rect
            x='3'
            y='4'
            width='18'
            height='16'
            rx='2'
        />
        <circle
            cx='9'
            cy='10'
            r='1.8'
        />
        <path d='M21 16l-5-5-9 9'/>
    </Svg>
);

export const MoveIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/>
        <path d='M10 14h6M13.5 11.5L16 14l-2.5 2.5'/>
    </Svg>
);

export const ArrowLeftIcon = (p: IconProps) => <Svg {...p}><path d='M20 12H4M10 6l-6 6 6 6'/></Svg>;

export const MenuIcon = (p: IconProps) => <Svg {...p}><path d='M4 6h16M4 12h16M4 18h16'/></Svg>;

export const SlidersIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M4 7h9M17 7h3M4 17h3M11 17h9'/>
        <circle
            cx='15'
            cy='7'
            r='2'
        />
        <circle
            cx='9'
            cy='17'
            r='2'
        />
    </Svg>
);

export const ThumbDownIcon = (p: IconProps) => (
    <Svg {...p}>
        <path d='M17 3v11M17 3h2.5A1.5 1.5 0 0 1 21 4.5v8a1.5 1.5 0 0 1-1.5 1.5H17l-4 7a2 2 0 0 1-2-2v-4H5.5a2 2 0 0 1-2-2.3l1.2-7A2 2 0 0 1 6.7 3z'/>
    </Svg>
);

export const MoreVerticalIcon = (p: IconProps) => (
    <svg
        className={p.className}
        width={p.size || 16}
        height={p.size || 16}
        viewBox='0 0 24 24'
        fill='currentColor'
        aria-hidden='true'
    >
        <circle
            cx='12'
            cy='5'
            r='1.8'
        />
        <circle
            cx='12'
            cy='12'
            r='1.8'
        />
        <circle
            cx='12'
            cy='19'
            r='1.8'
        />
    </svg>
);

export const BookmarkIcon = ({filled, ...p}: IconProps & {filled?: boolean}) => (
    <svg
        className={p.className}
        width={p.size || 16}
        height={p.size || 16}
        viewBox='0 0 24 24'
        fill={filled ? 'currentColor' : 'none'}
        stroke='currentColor'
        strokeWidth={2}
        strokeLinejoin='round'
        aria-hidden='true'
    >
        <path d='M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.5L5 21V4.5a1 1 0 0 1 1-1z'/>
    </svg>
);

export const CircleIcon = ({filled, ...p}: IconProps & {filled?: boolean}) => (
    <svg
        className={p.className}
        width={p.size || 16}
        height={p.size || 16}
        viewBox='0 0 24 24'
        aria-hidden='true'
    >
        <circle
            cx='12'
            cy='12'
            r={filled ? 6 : 7}
            fill={filled ? 'currentColor' : 'none'}
            stroke='currentColor'
            strokeWidth={2}
        />
    </svg>
);
