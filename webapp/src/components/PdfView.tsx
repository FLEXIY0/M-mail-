import React from 'react';

import manifest from 'manifest';

import {Spinner} from './icons';

// PDF attachments are drawn by PDF.js, the viewer of Firefox: the same in
// browsers, in the desktop app and on Safari, and nothing in the file runs
// as code. The library is large, so it is loaded from the plugin's public
// files only when the first PDF is opened.

interface PdfPage {
    getViewport: (o: {scale: number}) => {width: number; height: number};
    render: (o: {canvasContext: CanvasRenderingContext2D; viewport: unknown}) => {promise: Promise<void>};
}

interface PdfDocument {
    numPages: number;
    getPage: (n: number) => Promise<PdfPage>;
    destroy: () => Promise<void>;
}

interface PdfJs {
    GlobalWorkerOptions: {workerSrc: string};
    getDocument: (o: Record<string, unknown>) => {promise: Promise<PdfDocument>};
}

const MAX_PAGES = 50;

function base() {
    return `${window.basename || ''}/plugins/${manifest.id}/public/pdfjs`;
}

let pdfjs: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
    if (!pdfjs) {
        // A native import: webpack must not bundle this file.
        pdfjs = (import(/* webpackIgnore: true */ `${base()}/pdf.min.js?v=${manifest.version}`) as Promise<PdfJs>).then((lib) => {
            lib.GlobalWorkerOptions.workerSrc = `${base()}/pdf.worker.min.js?v=${manifest.version}`;
            return lib;
        }).catch((e) => {
            pdfjs = null;
            throw e;
        });
    }
    return pdfjs;
}

function PdfCanvas({doc, number, width}: {doc: PdfDocument; number: number; width: number}) {
    const ref = React.useRef<HTMLCanvasElement>(null);
    React.useEffect(() => {
        let cancelled = false;
        doc.getPage(number).then((page) => {
            const canvas = ref.current;
            if (cancelled || !canvas) {
                return;
            }
            const ratio = window.devicePixelRatio || 1;
            const scale = Math.max(width, 200) / page.getViewport({scale: 1}).width;
            const viewport = page.getViewport({scale: scale * ratio});
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            canvas.style.width = `${viewport.width / ratio}px`;
            canvas.style.height = `${viewport.height / ratio}px`;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                page.render({canvasContext: ctx, viewport});
            }
        });
        return () => {
            cancelled = true;
        };
    }, [doc, number, width]);
    return (
        <canvas
            ref={ref}
            className='mml-pdf__page'
            aria-label={`Страница ${number}`}
        />
    );
}

export default function PdfView({url, onFallback}: {url: string; onFallback: () => React.ReactNode}) {
    const box = React.useRef<HTMLDivElement>(null);
    const [doc, setDoc] = React.useState<PdfDocument | null>(null);
    const [failed, setFailed] = React.useState(false);
    const [width, setWidth] = React.useState(360);
    const [zoom, setZoom] = React.useState(1);

    React.useEffect(() => {
        let current: PdfDocument | null = null;
        let cancelled = false;
        loadPdfJs().
            then((lib) => lib.getDocument({url, withCredentials: true, standardFontDataUrl: `${base()}/standard_fonts/`, isEvalSupported: false}).promise).
            then((d) => {
                current = d;
                if (cancelled) {
                    d.destroy();
                } else {
                    setDoc(d);
                }
            }).
            catch(() => !cancelled && setFailed(true));
        return () => {
            cancelled = true;
            current?.destroy();
        };
    }, [url]);

    React.useLayoutEffect(() => {
        const el = box.current;
        if (!el) {
            return undefined;
        }
        const update = () => setWidth(el.clientWidth - 24);
        update();
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    if (failed) {
        return <>{onFallback()}</>;
    }
    const pages = doc ? Math.min(doc.numPages, MAX_PAGES) : 0;
    return (
        <div
            ref={box}
            className='mml-pdf'
        >
            {!doc && <div className='mml-viewer__center'><Spinner size={24}/></div>}
            {doc && (
                <>
                    <div className='mml-pdf__zoom'>
                        <button
                            type='button'
                            className='mml-icon-btn'
                            aria-label='Уменьшить'
                            onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
                        >
                            {'−'}
                        </button>
                        <span className='mml-small'>{`${Math.round(zoom * 100)}%`}</span>
                        <button
                            type='button'
                            className='mml-icon-btn'
                            aria-label='Увеличить'
                            onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
                        >
                            {'+'}
                        </button>
                        <span className='mml-muted mml-small'>{`Страниц: ${doc.numPages}`}</span>
                    </div>
                    {Array.from({length: pages}, (_, i) => (
                        <PdfCanvas
                            key={i + 1}
                            doc={doc}
                            number={i + 1}
                            width={width * zoom}
                        />
                    ))}
                    {doc.numPages > MAX_PAGES && <div className='mml-hint'>{`Показаны первые ${MAX_PAGES} страниц. Полностью — скачайте файл.`}</div>}
                </>
            )}
        </div>
    );
}
