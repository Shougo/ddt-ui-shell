# ddt-ui-shell

Shell UI for ddt.vim

## Required

### denops.vim

https://github.com/vim-denops/denops.vim

### ddt.vim

https://github.com/Shougo/ddt.vim

It requires "--unstable-ffi" for |g:denops#server#deno_args|.

## Configuration

```vim
let g:denops#server#deno_args = [
    \   '-q',
    \   '-A',
    \ ]
let g:denops#server#deno_args += ['--unstable-ffi']

call ddt#custom#patch_global(#{
    \   ui: 'shell',
    \ })
```
