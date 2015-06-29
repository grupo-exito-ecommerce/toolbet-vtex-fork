module.exports = (grunt) ->
  pkg = grunt.file.readJSON('package.json')
  config =
    coffee:
      main:
        files: [
          expand: true
          cwd: 'src'
          src: ['**/*.coffee']
          dest: "lib"
          ext: '.js'
        ]

    copy:
      main:
        options:
          process: (content, srcpath) ->
            return "#!/usr/bin/env node\n" + content
        files: [
          expand: true
          cwd: 'lib'
          src: ['*.js']
          dest: "lib"
        ]

    coffeelint:
      options:
        "max_line_length":
          level: "ignore"
        "no_unnecessary_fat_arrows":
          level: "ignore"

      main:
        src: ['src/**/*.coffee']

    watch:
      coffee:
        files: ['src/**/*.coffee']
        tasks: ['coffeelint', 'coffee', 'copy']
      grunt:
        files: ['Gruntfile.coffee']

  tasks =
  # Building block tasks
    build: ['coffeelint', 'coffee', 'copy']
  # Development tasks
    default: ['build', 'watch']

  # Project configuration.
  grunt.initConfig config
  grunt.loadNpmTasks name for name of pkg.devDependencies when name[0..5] is 'grunt-'
  grunt.registerTask taskName, taskArray for taskName, taskArray of tasks