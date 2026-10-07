// ---------------------------------------------------------------------------
// Custom Jest resolver for @chaincraft/game-server
//
// #chaincraft/* means different things depending on who imports it: the
// runtime's dist uses it for runtime internals, game-server source uses it for
// its own modules. #compiler/* and #gamedef/* come from those packages' dist.
// ---------------------------------------------------------------------------

const path = require('path');

const ROOT = __dirname;
const RUNTIME_DIST = path.resolve(ROOT, '../chaincraft-runtime/dist');
const COMPILER_DIST = path.resolve(ROOT, '../chaincraft-compiler/dist');
const GAMEDEF_DIST = path.resolve(ROOT, '../gamedef/dist');

function subpathOf(request, prefix) {
  return request.replace(prefix, '').replace(/\.js$/, '');
}

module.exports = (request, options) => {
  if (request.startsWith('#chaincraft/')) {
    const subpath = subpathOf(request, '#chaincraft/');
    if (options.basedir && options.basedir.includes('chaincraft-runtime')) {
      return path.join(RUNTIME_DIST, subpath + '.js');
    }
    return path.join(ROOT, 'src', subpath + '.ts');
  }

  if (request.startsWith('#compiler/')) {
    return path.join(COMPILER_DIST, subpathOf(request, '#compiler/') + '.js');
  }

  if (request.startsWith('#gamedef/')) {
    return path.join(GAMEDEF_DIST, subpathOf(request, '#gamedef/') + '.js');
  }

  return options.defaultResolver(request, options);
};
