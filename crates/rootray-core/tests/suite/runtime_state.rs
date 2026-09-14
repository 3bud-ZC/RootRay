use rootray_core::state::{RuntimePhase, RuntimeState};

/// Helper kept deliberately tiny: state-machine legality is the whole point.
fn phase_of(s: &RuntimeState) -> RuntimePhase {
    s.phase
}

#[test]
fn golden_path_transitions() {
    let mut s = RuntimeState::default();
    let path = [
        RuntimePhase::Analyzing,
        RuntimePhase::Ready,
        RuntimePhase::Starting,
        RuntimePhase::Running,
        RuntimePhase::Stopping,
        RuntimePhase::Stopped,
        RuntimePhase::Starting, // restart
        RuntimePhase::Running,
        RuntimePhase::Stopping,
        RuntimePhase::Stopped,
        RuntimePhase::Idle,
    ];
    for p in path {
        s.transition(p).unwrap_or_else(|e| panic!("-> {p:?} rejected: {e}"));
        assert_eq!(phase_of(&s), p);
    }
}

#[test]
fn crash_during_running_goes_failed() {
    let mut s = RuntimeState::default();
    for p in [
        RuntimePhase::Analyzing,
        RuntimePhase::Ready,
        RuntimePhase::Starting,
        RuntimePhase::Running,
    ] {
        s.transition(p).unwrap();
    }
    s.transition(RuntimePhase::Failed).unwrap();
    // Failed allows retry (start) and bail-out (idle / re-analyze).
    assert!(s.transition(RuntimePhase::Starting).is_ok());
}

#[test]
fn failed_startup_allows_restart() {
    let mut s = RuntimeState::default();
    for p in [RuntimePhase::Analyzing, RuntimePhase::Ready, RuntimePhase::Starting] {
        s.transition(p).unwrap();
    }
    s.transition(RuntimePhase::Failed).unwrap();
    assert!(s.transition(RuntimePhase::Starting).is_ok());
    assert!(s.transition(RuntimePhase::Running).is_ok());
}

#[test]
fn illegal_transitions_are_rejected() {
    let mut s = RuntimeState::default();
    // stop while idle
    assert!(s.transition(RuntimePhase::Stopping).is_err());
    // run without analyzing
    assert!(s.transition(RuntimePhase::Running).is_err());
    // start while already running
    for p in [RuntimePhase::Analyzing, RuntimePhase::Ready, RuntimePhase::Starting, RuntimePhase::Running] {
        s.transition(p).unwrap();
    }
    assert!(s.transition(RuntimePhase::Starting).is_err());
    // analyze while running
    assert!(s.transition(RuntimePhase::Analyzing).is_err());
    // ready directly from idle never allowed
    let mut s2 = RuntimeState::default();
    assert!(s2.transition(RuntimePhase::Ready).is_err());
}

#[test]
fn starting_clears_previous_run_fields() {
    let mut s = RuntimeState::default();
    for p in [RuntimePhase::Analyzing, RuntimePhase::Ready, RuntimePhase::Starting, RuntimePhase::Running, RuntimePhase::Stopping, RuntimePhase::Stopped] {
        s.transition(p).unwrap();
    }
    s.set_url("http://localhost:5173/".into(), Some(5173));
    s.transition(RuntimePhase::Starting).unwrap();
    assert!(s.url.is_none());
    assert!(s.port.is_none());
    assert!(s.pid.is_none());
}

#[test]
fn log_buffer_is_bounded() {
    let mut s = RuntimeState::default();
    for i in 0..600 {
        s.push_log(rootray_core::state::LogStream::Stdout, format!("line {i}"));
    }
    assert_eq!(s.recent_logs.len(), 500);
    assert_eq!(s.recent_logs.front().unwrap().line, "line 100");
}
