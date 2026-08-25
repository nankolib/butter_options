// Minimal React-hooks harness for identity tests.
//
// WHY NOT RNTL: wiring @testing-library/react-native + jest pulls a large dep tree
// and an npm install into a repo where installs prune packages and rewrite lockfiles.
// The defects under test are DEPENDENCY-IDENTITY defects — "does this value keep the
// same reference across renders" — which is exactly what a hook dispatcher decides.
// This harness implements React's documented hook semantics (Object.is comparison of
// dependency arrays) and nothing else. Full RNTL wiring is v1.1 per the vC3 scope.
//
// It is injected in place of the "react" module via require.cache, so the module
// under test is the REAL source file, unmodified.

function createHarness() {
  let hooks = [];
  let cursor = 0;
  const effects = [];

  const depsChanged = (prev, next) => {
    if (prev === undefined || next === undefined) return true;
    if (prev.length !== next.length) return true;
    for (let i = 0; i < prev.length; i += 1) {
      if (!Object.is(prev[i], next[i])) return true;
    }
    return false;
  };

  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in hooks)) {
        hooks[i] = { value: typeof initial === "function" ? initial() : initial };
      }
      const slot = hooks[i];
      const set = (next) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
      };
      return [slot.value, set];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { current: initial };
      return hooks[i];
    },
    useMemo(factory, deps) {
      const i = cursor++;
      const slot = hooks[i];
      if (!slot || depsChanged(slot.deps, deps)) {
        hooks[i] = { deps, value: factory() };
      }
      return hooks[i].value;
    },
    useCallback(fn, deps) {
      return react.useMemo(() => fn, deps);
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const slot = hooks[i];
      if (!slot || depsChanged(slot.deps, deps)) {
        hooks[i] = { deps };
        effects.push(fn);
      }
    }
  };

  return {
    react,
    /** Render the hook once; returns its result. Call repeatedly to re-render. */
    render(hookFn) {
      cursor = 0;
      const result = hookFn();
      while (effects.length) {
        const fn = effects.shift();
        try { fn(); } catch { /* effect bodies are not under test here */ }
      }
      return result;
    },
    reset() { hooks = []; cursor = 0; effects.length = 0; }
  };
}

/**
 * Stub react-native. useMarketState imports AppState from it, and requiring the
 * real package pulls in Flow-typed source that Node cannot parse.
 */
function installReactNative() {
  const path = require.resolve("react-native");
  require.cache[path] = {
    id: path, filename: path, loaded: true,
    exports: {
      AppState: { addEventListener: () => ({ remove() {} }), currentState: "active" },
      Platform: { OS: "android", select: (o) => o.android }
    }
  };
}

/** Install the fake react into require.cache so the module under test picks it up. */
function installReact(react) {
  const path = require.resolve("react");
  require.cache[path] = { id: path, filename: path, loaded: true, exports: react };
}

module.exports = { createHarness, installReact, installReactNative };
