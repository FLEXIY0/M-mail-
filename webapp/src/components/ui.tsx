import React from 'react';

import {ArrowLeftIcon, CloseIcon, Spinner} from './icons';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'secondary' | 'tertiary' | 'danger' | 'ghost';
    size?: 'sm' | 'md' | 'lg';
    loading?: boolean;
    className?: string;
    disabled?: boolean;
};

export function Button({variant = 'secondary', size = 'md', loading, children, className = '', disabled, ...rest}: ButtonProps) {
    return (
        <button
            type='button'
            className={`mml-btn mml-btn--${variant} mml-btn--${size} ${className}`}
            disabled={disabled || loading}
            {...rest}
        >
            {loading && <Spinner size={14}/>}
            {children}
        </button>
    );
}

export function LinkButton({href, children, variant = 'secondary', size = 'md', className = ''}: {
    href: string;
    children: React.ReactNode;
    variant?: 'primary' | 'secondary' | 'tertiary';
    size?: 'sm' | 'md' | 'lg';
    className?: string;
}) {
    return (
        <a
            className={`mml-btn mml-btn--${variant} mml-btn--${size} ${className}`}
            href={href}
            target='_blank'
            rel='noopener noreferrer'
        >
            {children}
        </a>
    );
}

export function Toggle({checked, onChange, label, description, icon}: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
    description?: React.ReactNode;
    icon?: React.ReactNode;
}) {
    const id = React.useMemo(() => `mml-toggle-${Math.random().toString(36).slice(2)}`, []);
    return (
        <div className='mml-toggle-row'>
            {icon && <div className='mml-toggle-row__icon'>{icon}</div>}
            <label
                className='mml-toggle-row__text'
                htmlFor={id}
            >
                <span className='mml-toggle-row__label'>{label}</span>
                {description && <span className='mml-toggle-row__desc'>{description}</span>}
            </label>
            <button
                id={id}
                type='button'
                role='switch'
                aria-checked={checked}
                className={`mml-switch ${checked ? 'mml-switch--on' : ''}`}
                onClick={() => onChange(!checked)}
            >
                <span className='mml-switch__knob'/>
            </button>
        </div>
    );
}

export function Modal({title, onClose, children, footer, width = 640, closeLabel = 'Закрыть'}: {
    title: React.ReactNode;
    onClose: () => void;
    children: React.ReactNode;
    footer?: React.ReactNode;
    width?: number;
    closeLabel?: string;
}) {
    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [onClose]);

    return (
        <div
            className='mml-overlay'
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                    onClose();
                }
            }}
        >
            <div
                className='mml-modal'
                role='dialog'
                aria-modal='true'
                style={{maxWidth: width}}
            >
                <div className='mml-modal__header'>
                    <div className='mml-modal__title'>{title}</div>
                    <button
                        type='button'
                        className='mml-icon-btn'
                        onClick={onClose}
                        aria-label={closeLabel}
                        title={closeLabel}
                    >
                        <CloseIcon size={18}/>
                    </button>
                </div>
                <div className='mml-modal__body'>{children}</div>
                {footer && <div className='mml-modal__footer'>{footer}</div>}
            </div>
        </div>
    );
}

export function Callout({kind = 'info', title, children, action}: {
    kind?: 'info' | 'warning' | 'error' | 'success';
    title?: React.ReactNode;
    children?: React.ReactNode;
    action?: React.ReactNode;
}) {
    return (
        <div className={`mml-callout mml-callout--${kind}`}>
            <div className='mml-callout__content'>
                {title && <div className='mml-callout__title'>{title}</div>}
                {children && <div className='mml-callout__text'>{children}</div>}
            </div>
            {action && <div className='mml-callout__action'>{action}</div>}
        </div>
    );
}

export function Details({summary, children}: {summary: string; children: React.ReactNode}) {
    return (
        <details className='mml-details'>
            <summary>{summary}</summary>
            <div className='mml-details__body'>{children}</div>
        </details>
    );
}

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

// Linkify renders text with clickable http(s) links and nothing else, so
// event descriptions can never inject markup.
export function Linkify({text}: {text: string}) {
    const parts = text.split(URL_RE);
    return (
        <>
            {parts.map((part, i) => {
                if (i % 2 === 1) {
                    const trimmed = part.replace(/[.,;:!?]+$/, '');
                    const tail = part.slice(trimmed.length);
                    return (
                        <React.Fragment key={i}>
                            <a
                                href={trimmed}
                                target='_blank'
                                rel='noopener noreferrer'
                            >
                                {trimmed}
                            </a>
                            {tail}
                        </React.Fragment>
                    );
                }
                return <React.Fragment key={i}>{part}</React.Fragment>;
            })}
        </>
    );
}

// PanelPage is a screen inside the right-hand panel: a header with "back",
// a scrolling body and an optional sticky footer. It takes the same props
// as Modal, so dialogs became panel screens without rewriting them.
export function PanelPage({title, onClose, children, footer, closeLabel = 'Назад', icon = 'back', actions, className = ''}: {
    title: React.ReactNode;
    onClose: () => void;
    children: React.ReactNode;
    footer?: React.ReactNode;
    width?: number;
    closeLabel?: string;
    icon?: 'back' | 'close' | 'spinner';
    actions?: React.ReactNode;
    className?: string;
}) {
    return (
        <div
            className={`mml-page ${className}`}
            role='region'
            aria-label={typeof title === 'string' ? title : undefined}
            onKeyDown={(e) => {
                if (e.key === 'Escape' && !(e.target as HTMLElement).closest('.mml-picker__menu')) {
                    e.stopPropagation();
                    onClose();
                }
            }}
        >
            <div className='mml-page__header'>
                <button
                    type='button'
                    className='mml-icon-btn mml-page__back'
                    onClick={onClose}
                    aria-label={closeLabel}
                    title={closeLabel}
                >
                    {icon === 'spinner' && <Spinner size={18}/>}
                    {icon === 'close' && <CloseIcon size={20}/>}
                    {icon === 'back' && <ArrowLeftIcon size={20}/>}
                </button>
                <div className='mml-page__title'>{title}</div>
                {actions && <div className='mml-page__actions'>{actions}</div>}
            </div>
            <div className='mml-page__body'>{children}</div>
            {footer && <div className='mml-page__footer'>{footer}</div>}
        </div>
    );
}
