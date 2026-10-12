// The header switch for a room with a page: the page itself, or the room's chat.
export default function RoomViewToggle({ showPage, onChange }: { showPage: boolean, onChange: (page: boolean) => void }) {
  return (
    <div className="room-view-toggle" role="tablist" aria-label="Room view">
      <button
        type="button"
        role="tab"
        aria-selected={showPage}
        aria-label="Page"
        className={showPage ? 'room-view-toggle--on' : undefined}
        onClick={() => onChange(true)}
      >
        <span className="material-symbols-outlined" aria-hidden>grid_view</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={!showPage}
        aria-label="Chat"
        className={!showPage ? 'room-view-toggle--on' : undefined}
        onClick={() => onChange(false)}
      >
        <span className="material-symbols-outlined" aria-hidden>chat_bubble</span>
      </button>
    </div>
  )
}
