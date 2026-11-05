import { useState, type CSSProperties } from 'react';
import { set, toast } from '../../state/store';
import { cls, useBlobUrl, I } from '../common';
import { Markdown, ReactionGlyph } from '../markdown';
import type { AssetRef, Embed, MsgButton } from '@shared/ops';

type EmbedLike = Embed & { imageUrl?: string; thumbUrl?: string };

/** Rich cards (mostly from bots). Images are attachments of the same message, fetched peer to peer. */
export function Embeds({ embeds, c, author }: { embeds: EmbedLike[]; c?: string; author?: string }) {
  return (
    <div className="embeds">
      {embeds.map((e, i) => (
        <div key={i} className="embed" style={{ '--embed-color': e.color ?? 'var(--accent)' } as CSSProperties}>
          <div className="embed-main">
            {e.author && <div className="embed-author">{e.author}</div>}
            {e.title &&
              (e.url ? (
                <a className="embed-title link" href={e.url} target="_blank" rel="noopener noreferrer nofollow" title={e.url}>
                  <Markdown text={e.title} c={c} inlineOnly />
                </a>
              ) : (
                <div className="embed-title">
                  <Markdown text={e.title} c={c} inlineOnly />
                </div>
              ))}
            {e.description && (
              <div className="embed-desc">
                <Markdown text={e.description} c={c} />
              </div>
            )}
            {e.fields && e.fields.length > 0 && (
              <div className="embed-fields">
                {e.fields.map((f, j) => (
                  <div key={j} className={cls('embed-field', f.inline && 'inline')}>
                    <div className="embed-fname">
                      <Markdown text={f.name} c={c} inlineOnly />
                    </div>
                    <div className="embed-fvalue">
                      <Markdown text={f.value} c={c} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {(e.image || e.imageUrl) && <EmbedImage asset={e.image} url={e.imageUrl} c={c} author={author} />}
            {(e.footer || e.ts) && (
              <div className="embed-footer">
                {e.footer}
                {e.footer && e.ts ? ' · ' : ''}
                {e.ts ? new Date(e.ts).toLocaleString() : ''}
              </div>
            )}
          </div>
          {(e.thumb || e.thumbUrl) && (
            <div className="embed-thumb">
              <EmbedImage asset={e.thumb} url={e.thumbUrl} c={c} author={author} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function EmbedImage({ asset, url: given, c, author }: { asset?: AssetRef; url?: string; c?: string; author?: string }) {
  const fetched = useBlobUrl(asset ?? null, { c, owner: author });
  const url = given ?? fetched;
  if (!url) return <div className="embed-image loading" style={asset?.w && asset.h ? { aspectRatio: `${asset.w} / ${asset.h}` } : undefined} />;
  return (
    <img
      className="embed-image"
      src={url}
      alt=""
      loading="lazy"
      onClick={() => asset && set({ lightbox: { hash: asset.hash, name: 'image', mime: asset.mime } })}
    />
  );
}

/** Message buttons. Pressing one signs an `interact` op; the bot's host answers it. */
export function MessageButtons({ buttons, onPress, disabled }: { buttons: MsgButton[]; onPress: (b: MsgButton) => Promise<unknown> | void; disabled?: boolean }) {
  const [pressing, setPressing] = useState<string | null>(null);
  return (
    <div className="msg-buttons">
      {buttons.map((b) => {
        const inner = (
          <>
            {b.emoji && <ReactionGlyph e={b.emoji} />}
            {b.label && <span>{b.label}</span>}
            {b.style === 'link' && <I.external size={13} />}
          </>
        );
        if (b.style === 'link' && b.url)
          return (
            <a key={b.id} className="mbtn mbtn-link" href={b.url} target="_blank" rel="noopener noreferrer nofollow" title={b.url}>
              {inner}
            </a>
          );
        return (
          <button
            type="button"
            key={b.id}
            className={cls('mbtn', `mbtn-${b.style}`, pressing === b.id && 'busy')}
            disabled={disabled || b.disabled || pressing === b.id}
            onClick={async (e) => {
              e.stopPropagation();
              setPressing(b.id);
              try {
                await onPress(b);
              } catch (err) {
                toast((err as Error).message, 'error');
              }
              setTimeout(() => setPressing((p) => (p === b.id ? null : p)), 900);
            }}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}
