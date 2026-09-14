/**
 * PowerPoint (.pptx) tools over the self-contained OOXML container (1.0.0).
 *
 * `ppt_create` builds a widescreen deck as an ASCII-safe STORE package
 * published through the official fs channel. Pictures are embedded under
 * `ppt/media/*.svg` and referenced with internal `a:blip r:embed` relations;
 * each SVG contains the original PNG/JPEG/GIF bytes as a base64 data URI.
 * The model fully controls placement (x/y/w/h inches, contain/cover
 * cropping, alt text), and intrinsic sizes are sniffed from image headers so
 * omitted dimensions default to natural size. The create result echoes every
 * element's landing geometry, and the tools render a text wireframe sketch.
 *
 * `ppt_update` appends slides to an existing text-safe deck, preserving the
 * existing package and embedding any new images.
 *
 * `ppt_read` reads any real-world deck and returns, per slide in document
 * order: paragraphs, tables, notes, image counts/alt texts — plus an
 * `elements` array with every shape's bounding box in inches and the deck's
 * canvas size. True raster rendering stays out of scope on purpose: it would
 * need a headless renderer (a subprocess plus a binary dependency), which is
 * exactly what the dependency-free, no-commands contract forbids.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { FsContext, ResolvedOfficePath } from '../fschannel.ts';
interface SlideImageSpec {
    path: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    sizing?: 'contain' | 'cover';
    alt?: string;
}
interface SlideSpec {
    title?: string;
    paragraphs?: string[];
    bullets?: string[];
    notes?: string;
    images?: SlideImageSpec[];
}
export interface PptCreateArgs {
    path: string;
    title?: string;
    slides?: SlideSpec[];
    overwrite?: boolean;
}
export interface PptUpdateArgs {
    path: string;
    slides: SlideSpec[];
}
/** One placed element, echoed by create and parsed back by read. */
export interface SlideElementBox {
    type: 'text' | 'bullets' | 'image' | 'table';
    xIn: number;
    yIn: number;
    wIn: number;
    hIn: number;
    text?: string;
    items?: string[];
    alt?: string;
    /** Embedded media part path, for example `ppt/media/image1.svg`. */
    path?: string;
    sizing?: 'contain' | 'cover';
}
/** Build the whole deck as an ASCII-safe package plus the layout echo. */
export declare function buildPptxText(args: PptCreateArgs, exec: ToolRunContext, ctx: FsContext, deck: ResolvedOfficePath): Promise<{
    text: string;
    layout: Array<{
        index: number;
        elements: SlideElementBox[];
    }>;
}>;
/** Build an updated package by appending slides and embedding their images. */
export declare function buildPptxUpdateText(args: PptUpdateArgs, exec: ToolRunContext, ctx: FsContext, deck: ResolvedOfficePath, zip: unknown): Promise<{
    text: string;
    layout: Array<{
        index: number;
        elements: SlideElementBox[];
    }>;
    slideCount: number;
    embeddedImages: number;
}>;
/** Render one slide as an ASCII wireframe: the canvas frame plus boxes. */
export declare function sketchSlide(widthIn: number, heightIn: number, elements: Array<Pick<SlideElementBox, 'type' | 'xIn' | 'yIn' | 'wIn' | 'hIn' | 'text'>>): string;
export declare function registerPptTools(ctx: Context & FsContext): () => void;
export {};
